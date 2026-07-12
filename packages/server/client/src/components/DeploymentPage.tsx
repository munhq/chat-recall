import React, { useState } from 'react';
import { Card, Chip, Icon, Button } from './primitives';

interface DeploymentPageProps {
  onClose?: () => void;
}

type TabType = 'docker' | 'k8s' | 'pipeline';

export default function DeploymentPage({ onClose }: DeploymentPageProps) {
  const [activeTab, setActiveTab] = useState<TabType>('docker');

  return (
    <div className="cr-dashboard" style={{ flex: 1, overflowY: 'auto', background: 'var(--cr-ink-0)' }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 40px 64px' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2>Deployment Diagnostics</h2>
              <Chip kind="brand" size="sm">System Configuration</Chip>
            </div>
            <p className="cr-lead" style={{ marginTop: 4 }}>
              Monitor configurations, local Docker containers, cluster workloads, and CI/CD pipeline automation.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {onClose && (
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            )}
          </div>
        </div>

        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 24, borderBottom: '1px solid var(--cr-line-1)', paddingBottom: 12 }}>
          <button
            onClick={() => setActiveTab('docker')}
            style={{
              background: activeTab === 'docker' ? 'var(--cr-ink-2)' : 'transparent',
              color: activeTab === 'docker' ? 'var(--cr-fg-1)' : 'var(--cr-fg-3)',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 'var(--cr-radius-sm)',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="terminal" size={14} /> Local Docker Compose
          </button>
          <button
            onClick={() => setActiveTab('k8s')}
            style={{
              background: activeTab === 'k8s' ? 'var(--cr-ink-2)' : 'transparent',
              color: activeTab === 'k8s' ? 'var(--cr-fg-1)' : 'var(--cr-fg-3)',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 'var(--cr-radius-sm)',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="cloud" size={14} /> Kubernetes Cluster (K8s)
          </button>
          <button
            onClick={() => setActiveTab('pipeline')}
            style={{
              background: activeTab === 'pipeline' ? 'var(--cr-ink-2)' : 'transparent',
              color: activeTab === 'pipeline' ? 'var(--cr-fg-1)' : 'var(--cr-fg-3)',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 'var(--cr-radius-sm)',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: 13,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon name="zap" size={14} /> Build & CI/CD Pipelines
          </button>
        </div>

        {/* Content Pane */}
        {activeTab === 'docker' && <DockerPane />}
        {activeTab === 'k8s' && <KubernetesPane />}
        {activeTab === 'pipeline' && <PipelinePane />}

      </div>
    </div>
  );
}

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
      <span style={{ fontSize: 12, color: 'var(--cr-fg-3)' }}>{desc}</span>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre style={{
      background: 'var(--cr-ink-1)',
      border: '1px solid var(--cr-line-1)',
      borderRadius: 'var(--cr-radius-md)',
      padding: 16,
      fontFamily: 'var(--cr-font-mono)',
      fontSize: 12.5,
      color: 'var(--cr-fg-1)',
      overflowX: 'auto',
      margin: '8px 0 16px',
    }}>
      <code>{code}</code>
    </pre>
  );
}

function DockerPane() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card style={{ padding: 20 }}>
          <SectionHeading title="Quick Local Sandbox" desc="Spin up server + database dependencies" />
          <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
            For rapid feature testing and verification, the server is orchestrated locally using a dual-container setup with a dedicated PostgreSQL datastore.
          </p>
          <div style={{ marginTop: 16 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--cr-fg-3)' }}>Start Stack</span>
            <CodeBlock code="docker compose up -d" />
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--cr-fg-3)' }}>Stop Stack</span>
            <CodeBlock code="docker compose down" />
          </div>
        </Card>

        <Card style={{ padding: 20 }}>
          <SectionHeading title="Containers Health" desc="Active services status" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--cr-ink-1)', borderRadius: 'var(--cr-radius-sm)', border: '1px solid var(--cr-line-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cr-ok-500)', boxShadow: '0 0 8px var(--cr-ok-500)' }} />
                <div>
                  <strong style={{ fontSize: 13, fontFamily: 'var(--cr-font-mono)' }}>chat-recall-server</strong>
                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>Express & React backend</div>
                </div>
              </div>
              <Chip kind="ok" size="sm">Running :8080</Chip>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--cr-ink-1)', borderRadius: 'var(--cr-radius-sm)', border: '1px solid var(--cr-line-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cr-ok-500)', boxShadow: '0 0 8px var(--cr-ok-500)' }} />
                <div>
                  <strong style={{ fontSize: 13, fontFamily: 'var(--cr-font-mono)' }}>chat-recall-db</strong>
                  <div style={{ fontSize: 11, color: 'var(--cr-fg-3)' }}>PostgreSQL 16 with pgvector</div>
                </div>
              </div>
              <Chip kind="ok" size="sm">Running :5432</Chip>
            </div>
          </div>

          <div style={{ marginTop: 20, padding: 12, background: 'var(--cr-brand-surf)', border: '1px solid var(--cr-brand-line)', borderRadius: 'var(--cr-radius-sm)', fontSize: 12.5 }}>
            <strong style={{ color: 'var(--cr-brand-500)', display: 'block', marginBottom: 4 }}>Note on Local Storage:</strong>
            Persistent data is bind-mounted directly to the <code>PG_DATA_DIR</code> directory on the host to preserve indexed logs and memories between rebuilds.
          </div>
        </Card>
      </div>

      <Card style={{ padding: 20 }}>
        <SectionHeading title="Environment Configurations" desc="Configurable parameters inside .env file" />
        <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', marginBottom: 12 }}>
          Ensure your local <code>.env</code> file contains the correct keys to authorize client syncs and enable semantic search features:
        </p>
        <CodeBlock code={`# System Secret Keys
ADMIN_KEY=your_secure_admin_key_here

# Datastore Config
CHAT_RECALL_STORAGE=postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/chat_recall

# Vector Embeddings (Optional)
EMBEDDING_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key_here`} />
      </Card>
    </div>
  );
}

function KubernetesPane() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card style={{ padding: 20 }}>
          <SectionHeading title="Production Cluster Workload" desc="Namespace chat-recall configuration" />
          <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5 }}>
            The production instance runs on a Kubernetes cluster. Orchestrated workloads are deployed inside the isolated <code>chat-recall</code> namespace.
          </p>
          <div style={{ marginTop: 16 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--cr-fg-3)' }}>Deployment Status Check</span>
            <CodeBlock code="kubectl get deployments -n chat-recall" />
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--cr-fg-3)' }}>Monitor Active Pods</span>
            <CodeBlock code="kubectl get pods -n chat-recall -w" />
          </div>
        </Card>

        <Card style={{ padding: 20 }}>
          <SectionHeading title="Local Redeployment Tooling" desc="Fast restart & container refresh scripts" />
          <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5, marginBottom: 14 }}>
            For local overrides or staging checks, platform operators can execute the automated deployment runner. This retrieves container registry credentials, builds the image, and updates the cluster deployment:
          </p>
          <CodeBlock code="# Run local compilation & deploy rollout
./scripts/deploy-local.sh" />
          <p style={{ fontSize: 12, color: 'var(--cr-fg-3)', lineHeight: 1.4 }}>
            The script logs in to <code>ghcr.io</code>, builds the production server container using <code>docker/Dockerfile.server</code>, pushes the image, and executes:
          </p>
          <CodeBlock code="kubectl rollout restart deployment chat-recall -n chat-recall" />
        </Card>
      </div>

      <Card style={{ padding: 20 }}>
        <SectionHeading title="Microservices & Worker Architecture" desc="Decoupled background workflows" />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginTop: 12 }}>
          <div style={{ padding: 14, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)' }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--cr-fg-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cr-ok-500)' }} />
              chat-recall (Web Server)
            </div>
            <p style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginTop: 6, lineHeight: 1.4 }}>
              Serves the frontend application assets and processes HTTP queries, search indexing, and account configuration.
            </p>
          </div>

          <div style={{ padding: 14, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)' }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--cr-fg-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--cr-ok-500)' }} />
              chat-recall-worker (Queue Consumer)
            </div>
            <p style={{ fontSize: 12, color: 'var(--cr-fg-2)', marginTop: 6, lineHeight: 1.4 }}>
              Consumes task items from the background job queue (summaries computation, large codeindex outline saves).
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function PipelinePane() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card style={{ padding: 20 }}>
        <SectionHeading title="GitHub Actions Automation" desc="CI/CD workflows defined inside .github/workflows" />
        <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.5, marginBottom: 16 }}>
          Platform code merges trigger automated integration hooks to build, audit, test, and release container images.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)' }}>
            <strong style={{ fontSize: 13, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)' }}>build-chat-recall-cloud.yml</strong>
            <p style={{ fontSize: 12.5, color: 'var(--cr-fg-2)', marginTop: 4 }}>
              Fires on main branch push. Compiles server, runs unit audits, packs image, and publishes to GHCR. Continuous delivery updates production workload instantly via Keel webhooks.
            </p>
          </div>

          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)' }}>
            <strong style={{ fontSize: 13, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)' }}>compose-integration.yml</strong>
            <p style={{ fontSize: 12.5, color: 'var(--cr-fg-2)', marginTop: 4 }}>
              Runs on all pull requests. Spins up Postgres, validates database schemas, executes database migrations, and validates search functionality.
            </p>
          </div>

          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-md)' }}>
            <strong style={{ fontSize: 13, fontFamily: 'var(--cr-font-mono)', color: 'var(--cr-fg-1)' }}>fresh-install.yml</strong>
            <p style={{ fontSize: 12.5, color: 'var(--cr-fg-2)', marginTop: 4 }}>
              Verifies compilation, NPM packaging, client installer script (<code>install.sh</code>), and zero-friction initialization workflows.
            </p>
          </div>
        </div>
      </Card>

      <Card style={{ padding: 20 }}>
        <SectionHeading title="Development Deployment Loop" desc="For connected systems and trading applications (e.g. Poly)" />
        <p style={{ fontSize: 13, color: 'var(--cr-fg-2)', lineHeight: 1.55 }}>
          If you are working on connected repositories (such as the <code>poly</code> trading framework or custom bots) that sync back to this server, remember the staging workflow doesn’t require standard Git pushes. Follow this direct rollout cycle:
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginTop: 16 }}>
          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 11, color: 'var(--cr-brand-500)', fontWeight: 600 }}>STEP 1</div>
            <div style={{ fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, marginTop: 4 }}>Modify files locally</div>
          </div>
          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 11, color: 'var(--cr-brand-500)', fontWeight: 600 }}>STEP 2</div>
            <div style={{ fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, marginTop: 4 }}>Run push-to-gitlab.sh</div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2 }}>Builds &amp; pushes image</div>
          </div>
          <div style={{ padding: 12, background: 'var(--cr-ink-1)', border: '1px solid var(--cr-line-1)', borderRadius: 'var(--cr-radius-sm)', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--cr-font-mono)', fontSize: 11, color: 'var(--cr-brand-500)', fontWeight: 600 }}>STEP 3</div>
            <div style={{ fontSize: 13, color: 'var(--cr-fg-1)', fontWeight: 500, marginTop: 4 }}>Run redeploy.sh</div>
            <div style={{ fontSize: 11, color: 'var(--cr-fg-3)', marginTop: 2 }}>Copies config &amp; restarts</div>
          </div>
        </div>
      </Card>
    </div>
  );
}
