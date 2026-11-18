#!/usr/bin/env bash
set -euo pipefail
umask 077

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
ip=${1:?Indica l'indirizzo IPv4 LAN di ZimaOS}
radar_env=${2:-/DATA/AppData/StreamRadar-IT/.env}
config=.env.prova

if ! ip -4 -o addr show | awk '{split($4, a, "/"); print a[1]}' | grep -Fx -- "$ip" >/dev/null; then
    printf 'Indirizzo IPv4 non assegnato a ZimaOS: %s\n' "$ip" >&2
    exit 1
fi

mkdir -p downloads
if [[ ! -f "$config" ]]; then
    password=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    (
        set -o noclobber
        {
            if [[ -r "$radar_env" ]]; then
                awk '/^[[:blank:]]*(export[[:blank:]]+)?(TMDB_READ_TOKEN|STREAMING_API_KEY|OMDB_API_KEY)[[:blank:]]*=/ {
                    sub(/\r$/, "")
                    print
                }' "$radar_env"
            else
                printf 'Chiavi Radar da configurare in %s.\n' "$config" >&2
            fi
            printf '\nAPP_BIND_IP=%s\nAPP_PORT=8790\nLSM_DATA_PATH=./downloads\nLSM_PASSWORD=%s\n' "$ip" "$password"
        } > "$config"
    )
fi

if ! grep -Fx "APP_BIND_IP=$ip" "$config" >/dev/null; then
    printf 'Controlla APP_BIND_IP in %s.\n' "$config" >&2
    exit 1
fi

export APP_BIND_IP="$ip" APP_PORT=8790 LSM_DATA_PATH=./downloads
compose=(docker compose --env-file "$config" -p streamsuite-prova -f compose.yaml)
"${compose[@]}" config --quiet
"${compose[@]}" up -d --build
"${compose[@]}" ps

url="http://$ip:8790"
for ((attempt=0; attempt<25; attempt++)); do
    if curl -fsS --max-time 2 "$url/" -o /dev/null 2>/dev/null &&
        curl -fsS --max-time 2 "$url/radar/healthz" -o /dev/null 2>/dev/null &&
        [[ "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "$url/manager/" 2>/dev/null)" == 401 ]]; then
        printf '\nStreamSuite di prova attiva su %s/\n' "$url"
        printf 'Local Stream Manager: utente admin, password nel campo LSM_PASSWORD di %s/%s.\n' "$PWD" "$config"
        exit 0
    fi
    sleep 2
done
printf 'Verifica HTTP fallita per %s. Log con docker compose --env-file %s -p streamsuite-prova logs --tail=50.\n' "$url" "$config" >&2
exit 1
