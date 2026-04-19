import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployContext } from '../types.js';
import { az, azQuiet, azJson, azTsv } from '../utils/az.js';
import { sh, shOrThrow, shIdempotent } from '../utils/shell.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

// Match the ORCA HQ production Qdrant-on-AKS config exactly.
// See orca-hq-config-repo/CLAUDE.md § "Qdrant — On AKS".
const AKS_K8S_VERSION = '1.34';
const AKS_NODE_VM_SIZE = 'Standard_D4lds_v6';
const AKS_NODE_COUNT = 1;
const QDRANT_HELM_REPO = 'https://qdrant.github.io/qdrant-helm';
const QDRANT_HELM_CHART_VERSION = '1.17.1';
const QDRANT_NAMESPACE = 'qdrant';
const QDRANT_PVC_SIZE = '20Gi';
const QDRANT_STORAGE_CLASS = 'managed-csi-premium';

function aksResourceGroupName(customer: string, region: string): string {
  return `rg-orca-${customer}-aks-${naming.regionShort(region)}`;
}

function aksClusterName(customer: string, region: string): string {
  return `orca-${customer}-aks-${naming.regionShort(region)}`;
}

/**
 * Step 1: Provision AKS cluster for Qdrant.
 *
 * Idempotent — if cluster exists, returns existing.
 * Stores aksResourceGroup + aksClusterName on the context.
 */
export async function createAksCluster(ctx: DeployContext): Promise<void> {
  const aksRg = aksResourceGroupName(ctx.customerSlug, ctx.region);
  const cluster = aksClusterName(ctx.customerSlug, ctx.region);
  const s = log.spinner(`AKS cluster: ${cluster}`);

  // 1a. Resource group (separate from main RG — matches HQ pattern).
  await azQuiet(`group create --name ${aksRg} --location ${ctx.region}`);

  // 1b. Check whether the cluster already exists.
  const existing = await az(`aks show --name ${cluster} --resource-group ${aksRg} -o none`);
  const exists = existing.exitCode === 0;

  if (!exists) {
    // Register the AKS resource provider + preview features if needed.
    // These are no-ops if already registered.
    await azQuiet(`provider register --namespace Microsoft.ContainerService --wait`);

    const createArgs = [
      `aks create`,
      `--name ${cluster}`,
      `--resource-group ${aksRg}`,
      `--location ${ctx.region}`,
      `--kubernetes-version ${AKS_K8S_VERSION}`,
      `--node-vm-size ${AKS_NODE_VM_SIZE}`,
      `--node-count ${AKS_NODE_COUNT}`,
      `--tier free`,
      `--enable-managed-identity`,
      `--enable-addons azure-keyvault-secrets-provider`,
      `--enable-oidc-issuer`,
      `--enable-workload-identity`,
      `--enable-secret-rotation`,
      `--generate-ssh-keys`,
      `--yes`,
    ].join(' ');

    // AKS create can take 8-12 minutes — extend timeout beyond azQuiet's
    // default 120s by calling az() directly with a long timeout.
    const createResult = await az(createArgs);
    if (createResult.exitCode !== 0) {
      const realError = createResult.stderr
        .split('\n')
        .some(line => line.startsWith('ERROR:'));
      if (realError) {
        s.fail(`  AKS cluster: ${cluster} (create failed)`);
        throw new Error(`az ${createArgs} failed: ${createResult.stderr}`);
      }
    }
  }

  const info = await azJson<{ id: string; name: string; powerState?: { code: string } }>(
    `aks show --name ${cluster} --resource-group ${aksRg} --query "{id:id, name:name, powerState:powerState}"`,
  );

  ctx.aksResourceGroup = aksRg;
  ctx.aksClusterName = info.name;

  s.succeed(`  AKS cluster: ${cluster}${exists ? ' (existing)' : ''}`);
}

/**
 * Step 2: Install Qdrant on the AKS cluster via Helm.
 *
 * Idempotent — `helm upgrade --install` handles first-run and re-run.
 * Exposes Qdrant via an Azure Internal Load Balancer and stores the VIP
 * on ctx.qdrantInternalUrl.
 */
export async function installQdrant(ctx: DeployContext): Promise<void> {
  if (!ctx.aksResourceGroup || !ctx.aksClusterName) {
    throw new Error('installQdrant requires ctx.aksResourceGroup and ctx.aksClusterName');
  }

  const s = log.spinner(`Qdrant on AKS (namespace: ${QDRANT_NAMESPACE})`);

  // 2a. Merge kubeconfig.
  await shOrThrow(
    `az aks get-credentials --resource-group ${ctx.aksResourceGroup} --name ${ctx.aksClusterName} --overwrite-existing`,
  );

  // 2b. Add Helm repo (tolerate "already exists" on re-run).
  await shIdempotent(
    `helm repo add qdrant ${QDRANT_HELM_REPO}`,
    ['already exists'],
  );
  await shOrThrow(`helm repo update qdrant`);

  // 2c. Install or upgrade Qdrant.
  //
  // service.annotations needs the dotted Azure LB annotation encoded for
  // Helm's --set parser. We use --set-string with back-slash-escaped dots,
  // and quote the whole expression for the shell.
  const internalLbAnnotation =
    `service.annotations."service\\.beta\\.kubernetes\\.io/azure-load-balancer-internal"=true`;

  const helmArgs = [
    `helm upgrade --install qdrant qdrant/qdrant`,
    `--version ${QDRANT_HELM_CHART_VERSION}`,
    `--namespace ${QDRANT_NAMESPACE}`,
    `--create-namespace`,
    `--set persistence.storageClassName=${QDRANT_STORAGE_CLASS}`,
    `--set persistence.size=${QDRANT_PVC_SIZE}`,
    `--set service.type=LoadBalancer`,
    `--set-string '${internalLbAnnotation}'`,
    `--wait --timeout 10m`,
  ].join(' ');

  await shOrThrow(helmArgs, 15 * 60_000);

  // 2d. Wait for the qdrant-0 pod to report Ready (defensive — helm --wait
  // should already have done this, but the StatefulSet can still be rolling).
  await shOrThrow(
    `kubectl -n ${QDRANT_NAMESPACE} wait --for=condition=Ready pod/qdrant-0 --timeout=300s`,
    6 * 60_000,
  );

  // 2e. Resolve the Internal Load Balancer VIP. It can take up to ~60s
  // for Azure to allocate the address after the Service is created.
  let vip = '';
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await sh(
      `kubectl -n ${QDRANT_NAMESPACE} get svc qdrant -o jsonpath='{.status.loadBalancer.ingress[0].ip}'`,
      30_000,
    );
    const candidate = result.stdout.trim();
    if (result.exitCode === 0 && candidate.length > 0) {
      vip = candidate;
      break;
    }
    await new Promise(r => setTimeout(r, 5_000));
  }

  if (!vip) {
    s.fail(`  Qdrant on AKS — Internal LB VIP did not appear within 3 minutes`);
    throw new Error('Qdrant Internal Load Balancer did not receive an IP within 180s');
  }

  ctx.qdrantInternalUrl = `http://${vip}:6333`;

  s.succeed(`  Qdrant on AKS — VIP ${vip} (HTTP :6333, gRPC :6334)`);
}

/**
 * Step 3: Deploy Qdrant snapshot + watchdog CronJobs.
 *
 * For the first deployment these are stubbed — the YAML is generated and
 * applied, but the operator must supply blob-storage + alert-URL bindings
 * before the jobs become useful. We print a clear post-deploy note so the
 * customer knows what to do next.
 */
export async function deployQdrantCronJobs(ctx: DeployContext): Promise<void> {
  if (!ctx.aksResourceGroup || !ctx.aksClusterName) {
    throw new Error('deployQdrantCronJobs requires AKS context');
  }

  const s = log.spinner(`Qdrant CronJobs (snapshot + watchdog)`);

  const snapshotYaml = `---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: qdrant-snapshot
  namespace: ${QDRANT_NAMESPACE}
  annotations:
    orca.hq/status: "stub — operator must bind blob storage + workload identity"
spec:
  schedule: "0 * * * *"   # hourly
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          # serviceAccountName: qdrant-snapshot-sa   # must be bound to a UAMI with blob write
          containers:
            - name: snapshot
              image: mcr.microsoft.com/azure-cli:latest
              env:
                - name: QDRANT_URL
                  value: "http://qdrant.${QDRANT_NAMESPACE}.svc.cluster.local:6333"
                - name: BLOB_CONTAINER
                  value: "qdrant-snapshots"
                # - name: STORAGE_ACCOUNT
                #   value: "<set post-deploy>"
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -euo pipefail
                  echo "[stub] Snapshot CronJob — operator must configure STORAGE_ACCOUNT + workload identity before enabling."
                  exit 0
`;

  const watchdogYaml = `---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: qdrant-watchdog
  namespace: ${QDRANT_NAMESPACE}
  annotations:
    orca.hq/status: "stub — operator must set GATEWAY_ALERT_URL"
spec:
  schedule: "*/2 * * * *"   # every 2 minutes
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: watchdog
              image: curlimages/curl:8.10.1
              env:
                - name: QDRANT_URL
                  value: "http://qdrant.${QDRANT_NAMESPACE}.svc.cluster.local:6333"
                # - name: GATEWAY_ALERT_URL
                #   value: "https://<gateway>/alert"
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -eu
                  if ! curl -fsS -m 5 "\${QDRANT_URL}/healthz" >/dev/null; then
                    echo "[watchdog] Qdrant healthz failed"
                    if [ -n "\${GATEWAY_ALERT_URL:-}" ]; then
                      curl -fsS -m 5 -X POST -H 'content-type: application/json' \
                        -d '{"source":"qdrant-watchdog","severity":"critical","message":"Qdrant healthz failed"}' \
                        "\${GATEWAY_ALERT_URL}" || true
                    fi
                    exit 1
                  fi
                  echo "[watchdog] ok"
`;

  const dir = await mkdtemp(join(tmpdir(), 'orca-qdrant-cron-'));
  const snapshotPath = join(dir, 'snapshot.yaml');
  const watchdogPath = join(dir, 'watchdog.yaml');

  try {
    await writeFile(snapshotPath, snapshotYaml, 'utf8');
    await writeFile(watchdogPath, watchdogYaml, 'utf8');

    // `kubectl apply` is idempotent by design — safe to re-run.
    await shOrThrow(`kubectl apply -f ${snapshotPath}`);
    await shOrThrow(`kubectl apply -f ${watchdogPath}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  s.succeed(`  Qdrant CronJobs (snapshot + watchdog) — stubs applied`);
  log.warn('Post-deploy: CronJobs are stubs. Before enabling:');
  log.dim('  • Create a storage account + `qdrant-snapshots` blob container.');
  log.dim('  • Bind a UAMI with Storage Blob Data Contributor via workload identity.');
  log.dim('  • Set STORAGE_ACCOUNT env + serviceAccountName on qdrant-snapshot.');
  log.dim('  • Set GATEWAY_ALERT_URL env on qdrant-watchdog.');
}

/**
 * Convenience wrapper — full AKS + Qdrant provisioning sequence.
 * Callers (e.g. deploy/index.ts) can invoke this as one step.
 */
export async function deployAksQdrant(ctx: DeployContext): Promise<void> {
  await createAksCluster(ctx);
  await installQdrant(ctx);
  await deployQdrantCronJobs(ctx);

  // Sanity check — the Internal LB VIP should be reachable from inside the
  // cluster. We don't try to reach it from the deployer's laptop because
  // that's deliberately blocked (Internal LB).
  const probe = await sh(
    `kubectl -n ${QDRANT_NAMESPACE} run qdrant-probe --rm -i --restart=Never --image=curlimages/curl:8.10.1 --timeout=60s --command -- curl -fsS -m 5 http://qdrant.${QDRANT_NAMESPACE}.svc.cluster.local:6333/readyz`,
    90_000,
  );
  if (probe.exitCode === 0) {
    log.success(`Qdrant readyz probe passed (in-cluster)`);
  } else {
    log.warn(`Qdrant readyz probe could not complete — verify manually: kubectl -n ${QDRANT_NAMESPACE} exec qdrant-0 -- curl -sS http://localhost:6333/readyz`);
  }

  if (ctx.qdrantInternalUrl) {
    log.info(`QDRANT_URL for gateway env: ${ctx.qdrantInternalUrl}`);
  }
}
