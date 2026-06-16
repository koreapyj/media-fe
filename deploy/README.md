# Running media-fe on Kubernetes

media-fe is a browser TV player served as static files by nginx. This guide gets it running on your
cluster. The container image is built automatically by GitHub Actions and published to GitHub
Container Registry (GHCR); you only configure and apply the manifests in `k8s/`.

## Before you start

- `kubectl` access to a cluster.
- A **Gateway API** controller with a Gateway you can attach routes to (Istio, Cilium, Contour,
  NGINX Gateway Fabric, …).
- The image `ghcr.io/koreapyj/media-fe`. It's public if the package visibility is set to public;
  otherwise see [Private image](#private-image).
- Your channel sources: one or more M3U playlist URLs (each may carry its own XMLTV EPG URL).

## 1. Configure

Edit the three files in `k8s/`:

**`configmap.yaml`** — your channels. List the M3U playlist URLs, and optionally widen the live
seek window per playlist:

```json
{
  "playlists": [
    "https://example.com/channels.m3u"
  ],
  "overrides": {
    "https://example.com/channels.m3u": { "availabilityWindow": 1800 }
  }
}
```

**`deployment.yaml`** — for reproducible rollouts, pin the image by digest instead of `latest`,
e.g. `image: ghcr.io/koreapyj/media-fe@sha256:<digest>`. The digest for each build is on the GHCR
package page (or `docker buildx imagetools inspect ghcr.io/koreapyj/media-fe:main`).

**`httproute.yaml`** — point at your Gateway and set your hostname:

```yaml
parentRefs:
  - name: my-gateway
    namespace: gateway-system
hostnames:
  - tv.example.com
```

(TLS is handled by your Gateway's listener. If you don't have a Gateway yet, `gateway.example.yaml`
is a starting template.)

## 2. Deploy

```sh
kubectl create namespace media-fe          # once, if it doesn't exist
kubectl apply -f k8s/ -n media-fe
kubectl rollout status deploy/media-fe -n media-fe
```

Then browse to `https://tv.example.com/<channel>/`. The bare root (`https://tv.example.com/`) has no
page by design — open the app at a channel URL.

## 3. Change channels later (no downtime)

Edit the playlist config; the change is picked up on the next browser reload, with no restart:

```sh
kubectl edit configmap media-fe-config -n media-fe
```

## 4. Check it's healthy

```sh
kubectl get pods -n media-fe
kubectl port-forward svc/media-fe 8080:80 -n media-fe
curl -s http://localhost:8080/healthz       # -> ok
curl -s http://localhost:8080/config.json   # -> your channel config
```

## Private image

If the GHCR package is private, give the cluster pull access:

```sh
kubectl create secret docker-registry ghcr-pull -n media-fe \
  --docker-server=ghcr.io --docker-username=<github-user> --docker-password=<token-with-read:packages>
```

Then uncomment the `imagePullSecrets` block in `k8s/deployment.yaml` and re-apply.

## Note on channel sources

The player streams everything directly from your playlist/EPG/CDN hosts in the browser. Those hosts
must allow cross-origin requests (send `Access-Control-Allow-Origin`); media-fe does not proxy them.
