#!/bin/bash
# Uso: /root/release-n8n.sh 2.46.4.1.0
#
# Faz o build da tag n8n@<versao> do fork pelo build proprio do n8n
# (pnpm build:docker) e publica lucaspeixotoadv/n8n:<versao> e
# lucaspeixotoadv/n8n-runners:<versao>. So se o build terminar bem, faz o
# deploy (/root/deploy-n8n.sh). Qualquer erro interrompe a cadeia.
# E o caminho quando o build do GitHub Actions na tag nao esta disponivel
# (.github/workflows/build-fork-docker-images.yml).
#
# INDIFERENTE AO TERMINAL: o script se relanca numa sessao propria e grava
# tudo em /root/release-n8n-<versao>-<data>.log, build e deploy no mesmo log.
# Fechar o terminal ou Ctrl+C so para de mostrar o log.
#
# Instalacao: veja o cabecalho do deploy-n8n.sh, que fica ao lado deste em /root/.
set -euo pipefail

VERSION="${1:?Informe a versao, ex: 2.46.4.1.0}"
VERSION="${VERSION#n8n@}"
TAG="n8n@$VERSION"
REPO=https://github.com/lucaspeixotoadv/n8n.git
BUILD_DIR=/root/n8n-build
LOCK=/run/lock/n8n-deploy.lock

if [ -z "${N8N_RELEASE_DETACHED:-}" ]; then
  LOG="/root/release-n8n-$VERSION-$(date +%Y%m%d-%H%M%S).log"
  : > "$LOG"
  N8N_RELEASE_DETACHED=1 setsid nohup "$(readlink -f "$0")" "$@" >> "$LOG" 2>&1 < /dev/null &
  echo "Release de $VERSION rodando fora do terminal (pid $!)."
  echo "Log: $LOG"
  echo "Fechar o terminal ou Ctrl+C so para de mostrar o log. Para voltar a ver: tail -f $LOG"
  echo
  # Sem `exec`: o shell continua pai do processo de fundo e o recolhe quando ele
  # termina, e e isso que encerra o `tail`.
  tail -n +1 -f "$LOG" --pid=$!
  exit 0
fi

# A trava vale para o deploy que este release chama: ele herda o descritor.
exec 9>"$LOCK"
flock -n 9 || { echo "Outro deploy ou release do n8n esta rodando ($LOCK)."; exit 1; }
export N8N_RELEASE_LOCKED=1
trap 'code=$?; echo; echo "release de $VERSION terminou em $(date "+%F %T") com codigo $code"' EXIT
echo "release de $VERSION comecou em $(date '+%F %T')"

IMG="lucaspeixotoadv/n8n:$VERSION"
RUNNERS="lucaspeixotoadv/n8n-runners:$VERSION"
step() { echo; echo "==> $*"; }

step "Codigo da tag $TAG em $BUILD_DIR"
[ -d "$BUILD_DIR/.git" ] || git clone --no-checkout "$REPO" "$BUILD_DIR"
cd "$BUILD_DIR"
git fetch --force "$REPO" "refs/tags/$TAG:refs/tags/$TAG"
git checkout --force --detach "$TAG"
# Apaga o que o build anterior gerou; as dependencias instaladas ficam,
# e o pnpm install do build as acerta pelo lockfile da tag.
git clean -ffdxq -e node_modules
echo "commit: $(git rev-parse --short HEAD)"
echo "node $(node -v), pnpm $(pnpm -v) (a tag pede node >= 24 e pnpm >= 12.4.2)"

step "Build das imagens (pnpm build:docker)"
export IMAGE_BASE_NAME=lucaspeixotoadv/n8n
export RUNNERS_IMAGE_BASE_NAME=lucaspeixotoadv/n8n-runners
export IMAGE_TAG="$VERSION"
time pnpm build:docker

step "Publicando as imagens"
docker push "$IMG"
docker push "$RUNNERS"

/root/deploy-n8n.sh "$VERSION"
