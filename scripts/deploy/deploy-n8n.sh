#!/bin/bash
# Uso: /root/deploy-n8n.sh 2.46.4.1.0
#
# Troca a stack n8n do Portainer (editor, webhook e worker) para a imagem
# lucaspeixotoadv/n8n:<versao>, que o release ja construiu neste servidor.
# O n8n migra o banco ao subir (um processo por vez, por trava no Postgres):
# o deploy para os servicos e aplica a stack com a tag nova.
# Parada: webhook e editor primeiro, worker por ultimo. A fila do Redis fica.
# Rollback: restaurar o backup diario do banco (3h) e voltar a stack.
# Roda fora do terminal, com log em /root/deploy-n8n-<versao>-<data>.log.
#
# Instalacao, a partir do clone do fork no servidor:
#   install -m 700 scripts/deploy/deploy-n8n.sh scripts/deploy/release-n8n.sh /root/
# Usa o /root/portainer-stack.py, instalado do repositorio do Chatwoot (script/deploy).
set -euo pipefail

VERSION="${1:?Informe a versao, ex: 2.46.4.1.0}"
VERSION="${VERSION#n8n@}"
LOCK=/run/lock/n8n-deploy.lock

# Mesmas variaveis do release-n8n.sh: chamado por ele, fica no log e na trava dele.
if [ -z "${N8N_RELEASE_DETACHED:-}" ]; then
  LOG="/root/deploy-n8n-$VERSION-$(date +%Y%m%d-%H%M%S).log"
  : > "$LOG"
  N8N_RELEASE_DETACHED=1 setsid nohup "$(readlink -f "$0")" "$@" >> "$LOG" 2>&1 < /dev/null &
  echo "Deploy de $VERSION rodando fora do terminal (pid $!). Log: $LOG"
  echo "Fechar o terminal ou Ctrl+C so para de mostrar. Para voltar a ver: tail -f $LOG"
  tail -n +1 -f "$LOG" --pid=$!
  exit 0
fi

if [ -z "${N8N_RELEASE_LOCKED:-}" ]; then
  exec 9>"$LOCK"
  flock -n 9 || { echo "Outro deploy ou release do n8n esta rodando ($LOCK)."; exit 1; }
  export N8N_RELEASE_LOCKED=1
fi

echo "deploy de $VERSION comecou em $(date '+%F %T')"
IMG="lucaspeixotoadv/n8n:$VERSION"
EDITOR=n8n_n8n_editor; WEBHOOK=n8n_n8n_webhook; WORKER=n8n_n8n_worker
STOP_ORDER=("$WEBHOOK" "$EDITOR" "$WORKER")
declare -A REPLICAS
STOPPED=; APPLIED=

step() { echo; echo "==> $*"; }

on_exit() {
  local code=$?
  if [ -n "$STOPPED" ] && [ -z "$APPLIED" ]; then
    echo; echo "ATENCAO: n8n PARADO na imagem antiga; o banco NAO foi migrado. Para voltar:"
    for s in "${STOP_ORDER[@]}"; do echo "   docker service scale $s=${REPLICAS[$s]}"; done
  elif [ -n "$STOPPED" ]; then
    echo; echo "ATENCAO: stack aplicada em $VERSION, mas os servicos nao ficaram prontos."
    echo "O banco pode estar migrado: veja docker service logs --since 30m $EDITOR"
    echo "Nao volte para a imagem antiga sem restaurar o backup diario do banco."
  fi
  echo; echo "deploy de $VERSION terminou em $(date '+%F %T') com codigo $code"
}
trap on_exit EXIT

cid_of() {
  local task
  task=$(docker service ps "$1" -f desired-state=running -q | head -1)
  [ -n "$task" ] || return 1
  docker inspect --format '{{.Status.ContainerStatus.ContainerID}}' "$task"
}
running_count() {
  docker service ps "$1" -f desired-state=running --format '{{.CurrentState}}' | grep -c '^Running' || true
}
# /healthz/readiness so responde 200 com o banco conectado e migrado
ready_http() {
  local cid
  cid=$(cid_of "$1") || return 1
  docker exec "$cid" node -e 'fetch(`http://127.0.0.1:${process.env.N8N_PORT || 5678}/healthz/readiness`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' >/dev/null 2>&1
}
logs_since() { docker service logs --raw --since "$START" "$1" 2>&1; }

step "Conferindo a imagem local $IMG"
docker image inspect "$IMG" >/dev/null || { echo "Imagem $IMG nao existe neste servidor."; exit 1; }
docker manifest inspect "$IMG" >/dev/null || { echo "Imagem $IMG nao esta no Docker Hub: outro no nao consegue baixar."; exit 1; }

step "Servicos no ar"
HOST=$(docker info --format '{{.Name}}')
for s in "${STOP_ORDER[@]}"; do
  r=$(docker service inspect "$s" --format '{{if .Spec.Mode.Replicated}}{{.Spec.Mode.Replicated.Replicas}}{{end}}')
  [ -n "$r" ] || { echo "ERRO: $s nao e um servico replicado."; exit 1; }
  REPLICAS[$s]=$r
  nodes=$(docker service ps "$s" -f desired-state=running --format '{{.Node}}' | sort -u | tr '\n' ' ')
  echo "   $s: $r replica(s), $(docker service inspect "$s" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'), no: ${nodes:-nenhum}"
  # O worker pode rodar em outro no: e conferido pelos logs, nao por docker exec.
  [ "$s" = "$WORKER" ] || for n in $nodes; do [ "$n" = "$HOST" ] || { echo "ERRO: $s roda em $n, fora deste no ($HOST)."; exit 1; }; done
done
grace=$(docker service inspect "$WORKER" --format '{{json .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}')
if [ "$grace" = null ] || [ "$grace" -lt 40000000000 ]; then
  echo "   AVISO: o worker desliga em $(( ${grace/null/10000000000} / 1000000000 ))s e o n8n espera ate 30s pelas execucoes: ponha 'stop_grace_period: 40s' no worker."
fi

step "Stack no Portainer: o que muda"
/root/portainer-stack.py plan "$VERSION" n8n

step "Parando os servicos"
STOPPED=1
for s in "${STOP_ORDER[@]}"; do
  echo "   $s: ${REPLICAS[$s]} -> 0"
  docker service scale --detach=false "$s=0" >/dev/null
done

step "Aplicando a stack em $VERSION (os servicos sobem na imagem nova e migram o banco)"
START=$(date +%s)
APPLIED=1
/root/portainer-stack.py set-image "$VERSION" n8n

step "Aguardando os servicos (ate 15 min)"
deadline=$((SECONDS + 900))
for s in "$EDITOR" "$WEBHOOK" "$WORKER"; do
  want=$(docker service inspect "$s" --format '{{.Spec.Mode.Replicated.Replicas}}')
  [ "$want" = "${REPLICAS[$s]}" ] || echo "   AVISO: $s tinha ${REPLICAS[$s]} replica(s), e a stack pede $want"
  [ "$want" -gt 0 ] || { echo "   $s: 0 replicas na stack"; continue; }
  until [ "$(running_count "$s")" -ge "$want" ]; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "ERRO: $s nao chegou a $want replica(s)"; docker service ps --no-trunc "$s" | head -5; exit 1; }
    sleep 3
  done
  if [ "$s" = "$WORKER" ]; then
    until logs_since "$s" | grep -q 'n8n worker is now ready'; do
      [ "$SECONDS" -lt "$deadline" ] || { echo "ERRO: $s nao ficou pronto"; logs_since "$s" | tail -20; exit 1; }
      sleep 3
    done
  else
    until ready_http "$s"; do
      [ "$SECONDS" -lt "$deadline" ] || { echo "ERRO: $s nao respondeu /healthz/readiness"; logs_since "$s" | tail -20; exit 1; }
      sleep 3
    done
  fi
  echo "   $s: pronto em $(docker service inspect "$s" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')"
done
STOPPED=

step "Migracoes que rodaram"
for s in "$EDITOR" "$WEBHOOK" "$WORKER"; do
  logs_since "$s" | grep -E 'Starting migration|Finished migration' | sed "s/^/   $s: /" || true
done
docker ps --filter name=n8n_ --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
step "Deploy de $VERSION concluido; a stack do Portainer ja esta em $VERSION."
