import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // In-Memory Kernel Engine Mock State for server
  let kernelVersion = 42;
  const identitiesMap = new Map<string, any>([
    [
      'iden::plan_0053',
      {
        id: 'iden::plan_0053',
        aliases: ['plan_0053', '0053', 'auth-module-v2'],
        label: 'Plan 0053 — Auth Module',
        node_ids: ['plan_0053'],
      },
    ],
    [
      'iden::plan_0054',
      {
        id: 'iden::plan_0054',
        aliases: ['plan_0054', '0054'],
        label: 'Plan 0054 — Storage Engine',
        node_ids: ['plan_0054'],
      },
    ],
  ]);

  const receiptsStore: any[] = [
    {
      id: 'RCP-PLAN-0053-1',
      plan_id: 'plan_0053',
      type: 'PROPOSED',
      agent_role: 'planner',
      session_id: 'sess-1001',
      ticket_id: 'TCK-2026-0053',
      artifact_path: 'IMPLEMENTATION_PLANS/pending/auth-module.md',
      summary: 'Initial proposal for Auth Module',
      metadata_json: '{"initiator": "planner_agent"}',
      tokens_used: 1200,
      created_at: '2026-07-25T08:00:00Z',
    },
    {
      id: 'RCP-PLAN-0053-2',
      plan_id: 'plan_0053',
      type: 'PLAN_CREATE',
      agent_role: 'planner',
      session_id: 'sess-1001',
      ticket_id: 'TCK-2026-0053',
      artifact_path: 'IMPLEMENTATION_PLANS/active/auth-module.md',
      summary: 'Plan created and validated',
      metadata_json: '{"consensus": 95}',
      tokens_used: 2400,
      created_at: '2026-07-25T09:30:00Z',
    },
  ];

  const sessionsStore: any[] = [
    {
      id: 'sess-1001',
      role: 'planner',
      state: 'running',
      detail: 'Decomposing plan_0053 requirements',
      pid: 14201,
      cost_usd: 1.25,
      started_at: new Date(Date.now() - 3600000).toISOString(),
      last_heartbeat: new Date().toISOString(),
    },
    {
      id: 'sess-1002',
      role: 'builder',
      state: 'running',
      detail: 'Executing test harness for plan_0054',
      pid: 14205,
      cost_usd: 3.50,
      started_at: new Date(Date.now() - 1800000).toISOString(),
      last_heartbeat: new Date().toISOString(),
    },
    {
      id: 'sess-1003',
      role: 'reviewer',
      state: 'stale',
      detail: 'Awaiting signature validation',
      pid: 13900,
      cost_usd: 0.45,
      started_at: new Date(Date.now() - 7200000).toISOString(),
      last_heartbeat: new Date(Date.now() - 4000000).toISOString(),
    },
  ];

  let circuitBreakerState = {
    tripped: false,
    paused: false,
    retry_after: 1800,
    source: '',
    error: '',
    detail: '',
    tripped_at: null as string | null,
    max_retries_per_model: 3,
    retry_delay_seconds: 120,
    max_fallbacks: 3,
    push_back_to_pending: true,
  };

  const lineageEventsStore: any[] = [
    {
      id: 1,
      version: 41,
      delta_id: 'delta-2026-07-24-080',
      step: 'reduce',
      event_type: 'apply',
      affected_plans: ['plan_0053'],
      detail: 'OK: 1 receipts reduced',
    },
    {
      id: 2,
      version: 42,
      delta_id: 'delta-2026-07-25-001',
      step: 'snapshot',
      event_type: 'checkpoint',
      affected_plans: ['plan_0053', 'plan_0054'],
      detail: 'Engine snapshot version 42 persisted',
    },
  ];

  // System Endpoints
  app.get('/api/info', (req, res) => {
    res.json({
      service: 'WRP Kernel Runtime',
      version: '0.1.0',
      docs: '/docs',
    });
  });

  app.get('/healthz', (req, res) => {
    res.json({ status: 'alive' });
  });

  app.get('/readyz', (req, res) => {
    res.json({ status: 'ready', kernel_version: kernelVersion });
  });

  app.get('/metrics', (req, res) => {
    const metrics = [
      '# HELP kernel_requests_total Total HTTP requests to WRP Kernel',
      '# TYPE kernel_requests_total counter',
      'kernel_requests_total{method="GET",path="/state",status="200"} 128',
      'kernel_requests_total{method="POST",path="/delta",status="200"} 42',
      '# HELP kernel_version Current WRP Kernel Version',
      '# TYPE kernel_version gauge',
      `kernel_version ${kernelVersion}`,
      '# HELP kernel_plan_count Total plans tracked',
      '# TYPE kernel_plan_count gauge',
      'kernel_plan_count 12',
      '# HELP kernel_receipt_count Total receipts stored',
      '# TYPE kernel_receipt_count gauge',
      `kernel_receipt_count ${receiptsStore.length}`,
      '# HELP kernel_identity_count Total identities resolved',
      '# TYPE kernel_identity_count gauge',
      `kernel_identity_count ${identitiesMap.size}`,
    ].join('\n');
    res.type('text/plain').send(metrics);
  });

  app.get('/api/status', (req, res) => {
    res.json({
      pgConnected: Boolean(process.env.CONDUIT_PG_DSN),
      pgDsn: process.env.CONDUIT_PG_DSN || 'postgresql://nexus_admin:***@postgres.internal.nexus:5432/nexus (stub)',
      pgSchema: process.env.CONDUIT_PG_SCHEMA || 'conduit',
      wrpKernelActive: true,
      wrpKernelUrl: process.env.WRP_KERNEL_URL || 'http://localhost:3103',
      mcpServerUrl: process.env.MCP_BASE_URL || 'http://localhost:3100',
      activeLeasesCount: sessionsStore.filter(s => s.state === 'running').length,
      circuitBreakerTripped: circuitBreakerState.tripped,
      lastSyncTimestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------
  // 1. Delta Ingestion (/delta)
  // -------------------------------------------------------------
  app.post('/delta', (req, res) => {
    const { delta_id, batch_id, receipts, affected_plans, invalidated_plans } = req.body || {};
    if (!delta_id || !Array.isArray(receipts)) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid KernelDelta payload: missing delta_id or receipts array',
        },
      });
    }

    kernelVersion += 1;
    receipts.forEach((r: any) => {
      receiptsStore.push({
        id: r.id || `RCP-${Date.now()}`,
        plan_id: r.plan_id || 'plan_0053',
        type: r.type || 'PLAN_CREATE',
        agent_role: r.agent_role || 'planner',
        session_id: 'sess-1001',
        ticket_id: r.ticket_id || 'TCK-AUTO',
        artifact_path: r.artifact_path || 'IMPLEMENTATION_PLANS/pending/auto.md',
        summary: r.summary || 'Ingested via POST /delta',
        metadata_json: r.metadata_json || '{}',
        tokens_used: r.tokens_used || 500,
        created_at: r.created_at || new Date().toISOString(),
      });
    });

    lineageEventsStore.push({
      id: lineageEventsStore.length + 1,
      version: kernelVersion,
      delta_id: delta_id,
      step: 'reduce',
      event_type: 'apply',
      affected_plans: affected_plans || [],
      detail: `OK: ${receipts.length} receipts processed in batch ${batch_id || 'manual'}`,
    });

    res.json({
      success: true,
      version: kernelVersion,
      delta_id,
      plan_count: 12,
      receipt_count: receiptsStore.length,
      error: null,
    });
  });

  app.get('/delta/state', (req, res) => {
    res.json({
      version: kernelVersion,
      plan_count: 12,
      receipt_count: receiptsStore.length,
      identity_count: identitiesMap.size,
      graph_edge_count: 34,
      lineage_event_count: lineageEventsStore.length,
    });
  });

  // -------------------------------------------------------------
  // 2. State Inspection (/state)
  // -------------------------------------------------------------
  app.get('/state', (req, res) => {
    const view = req.query.view || 'summary';
    const summary = {
      kernel_version: kernelVersion,
      plan_count: 12,
      receipt_count: receiptsStore.length,
      identity_count: identitiesMap.size,
      graph_edge_count: 34,
      lineage_event_count: lineageEventsStore.length,
      delta_log_count: kernelVersion,
    };

    if (view === 'full') {
      return res.json({
        ...summary,
        state: {
          identities: Array.from(identitiesMap.values()),
          receipts_count: receiptsStore.length,
          sessions_active: sessionsStore.length,
        },
      });
    }
    res.json(summary);
  });

  app.get('/state/health', (req, res) => {
    res.json({ status: 'ok', kernel_version: kernelVersion });
  });

  app.get('/state/identity/:identity_id', (req, res) => {
    const rawId = req.params.identity_id;
    let resolved = identitiesMap.get(rawId) || identitiesMap.get(`iden::${rawId}`);

    if (!resolved) {
      // search by alias
      for (const iden of identitiesMap.values()) {
        if (iden.aliases.includes(rawId) || iden.node_ids.includes(rawId)) {
          resolved = iden;
          break;
        }
      }
    }

    if (!resolved) {
      return res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Identity not found: ${rawId}`,
        },
      });
    }

    res.json({
      ...resolved,
      edges_outgoing: [
        { target: 'iden::plan_0052', relation: 'wrp:depends_on', metadata: {} },
      ],
      edges_incoming: [
        { source: 'iden::plan_0054', relation: 'wrp:impacts_system', metadata: {} },
      ],
    });
  });

  app.get('/state/receipt/:receipt_id', (req, res) => {
    const rc = receiptsStore.find(r => r.id === req.params.receipt_id);
    if (!rc) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Receipt not found: ${req.params.receipt_id}` },
      });
    }
    res.json({ id: rc.id, receipt: rc });
  });

  app.get('/state/receipts-by-plan/:plan_num', (req, res) => {
    const planNum = req.params.plan_num.startsWith('plan_') ? req.params.plan_num : `plan_${req.params.plan_num}`;
    const matches = receiptsStore.filter(r => r.plan_id === planNum);
    res.json({
      plan_num: planNum,
      receipts: matches,
      count: matches.length,
    });
  });

  app.get('/state/graph', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 200;
    const nodes = Array.from(identitiesMap.values()).map(i => ({
      id: i.id,
      aliases: i.aliases,
      label: i.label,
    }));
    const edges = [
      {
        source: 'iden::plan_0053',
        source_label: 'Plan 0053 — Auth Module',
        target: 'iden::plan_0054',
        target_label: 'Plan 0054 — Storage Engine',
        relation: 'wrp:depends_on',
        metadata: { priority: 'high' },
      },
      {
        source: 'iden::plan_0054',
        source_label: 'Plan 0054 — Storage Engine',
        target: 'iden::plan_0052',
        target_label: 'Plan 0052 — Core DB',
        relation: 'wrp:impacts_system',
        metadata: {},
      },
    ];

    res.json({
      nodes,
      edges,
      total_edges: edges.length,
      cursor: nodes.length > 0 ? nodes[nodes.length - 1].id : '',
      limit,
    });
  });

  app.get('/state/plan/:plan_num', (req, res) => {
    const planNum = req.params.plan_num.startsWith('plan_') ? req.params.plan_num : `plan_${req.params.plan_num}`;
    const planReceipts = receiptsStore.filter(r => r.plan_id === planNum);

    res.json({
      plan_num: planNum,
      identity_id: `iden::${planNum}`,
      aliases: [planNum, planNum.replace('plan_', '')],
      label: `Plan ${planNum.replace('plan_', '')}`,
      receipt_count: planReceipts.length,
      current_wrp_state: 'EXECUTING',
      valid_transitions: ['COMPLETED', 'BLOCKED', 'CANCELLED', 'ARCHIVED'],
      receipts: planReceipts,
      edges_outgoing: [{ target: 'iden::plan_0052', relation: 'wrp:depends_on', metadata: {} }],
      edges_incoming: [],
    });
  });

  app.get('/state/lineage', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 100;
    res.json({
      events: lineageEventsStore.slice(-limit),
      count: lineageEventsStore.length,
    });
  });

  // -------------------------------------------------------------
  // 3. Replay (/replay)
  // -------------------------------------------------------------
  app.get('/replay', (req, res) => {
    const targetVer = req.query.version ? parseInt(req.query.version as string) : kernelVersion;
    res.json({
      version: targetVer,
      plan_count: 12,
      receipt_count: Math.min(receiptsStore.length, targetVer * 2),
      identity_count: identitiesMap.size,
      graph_edge_count: 34,
      lineage_event_count: lineageEventsStore.length,
      reconstructed_from_version: targetVer,
    });
  });

  app.get('/replay/compare', (req, res) => {
    const ver = parseInt(req.query.version as string);
    if (isNaN(ver)) {
      return res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message: 'Missing required integer parameter: version' },
      });
    }

    const match = ver === kernelVersion;
    res.json({
      match,
      live_version: kernelVersion,
      replay_version: ver,
      live_plan_count: 12,
      replay_plan_count: match ? 12 : 11,
      live_receipt_count: receiptsStore.length,
      replay_receipt_count: match ? receiptsStore.length : receiptsStore.length - 1,
      live_identity_count: identitiesMap.size,
      replay_identity_count: identitiesMap.size,
      live_edge_count: 34,
      replay_edge_count: 34,
      diffs: match ? [] : [`Receipt count discrepancy at version ${ver}: live=${receiptsStore.length}, replay=${receiptsStore.length - 1}`],
    });
  });

  // -------------------------------------------------------------
  // 4. Admin (/admin)
  // -------------------------------------------------------------
  app.get('/admin/identities', (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const list = Array.from(identitiesMap.values());
    res.json({
      identities: list.slice(0, limit),
      total: list.length,
      cursor: list.length > 0 ? list[list.length - 1].id : '',
      limit,
    });
  });

  app.patch('/admin/identities/:identity_id', (req, res) => {
    const id = req.params.identity_id;
    const iden = identitiesMap.get(id) || identitiesMap.get(`iden::${id}`);
    if (!iden) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: `Identity not found: ${id}` },
      });
    }

    if (req.body.label) iden.label = req.body.label;
    if (Array.isArray(req.body.aliases)) iden.aliases = req.body.aliases;

    res.json({
      id: iden.id,
      label: iden.label,
      aliases: iden.aliases,
      updated: true,
    });
  });

  app.delete('/admin/identities/:identity_id', (req, res) => {
    const id = req.params.identity_id;
    const key = identitiesMap.has(id) ? id : `iden::${id}`;
    if (identitiesMap.has(key)) {
      identitiesMap.delete(key);
      return res.json({ ok: true, identity_id: key });
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `Identity not found: ${id}` } });
  });

  app.get('/admin/consistency', (req, res) => {
    res.json({
      aligned: true,
      engine_version: kernelVersion,
      delta_log_version: kernelVersion,
      engine_plan_count: 12,
      delta_log_count: kernelVersion,
      details: [
        `Version aligned: engine=${kernelVersion} == delta_log=${kernelVersion}`,
        'Plans tracked: 12',
        `Delta log entries: ${kernelVersion}`,
      ],
    });
  });

  // -------------------------------------------------------------
  // 5. Sessions (/api/sessions)
  // -------------------------------------------------------------
  app.get('/api/sessions', (req, res) => {
    const runningOnly = req.query.running_only === 'true';
    const result = runningOnly ? sessionsStore.filter(s => s.state === 'running') : sessionsStore;
    res.json(result);
  });

  app.get('/api/sessions/running', (req, res) => {
    res.json(sessionsStore.filter(s => s.state === 'running'));
  });

  app.get('/api/sessions/stale', (req, res) => {
    res.json(sessionsStore.filter(s => s.state === 'stale'));
  });

  app.get('/api/sessions/:session_id', (req, res) => {
    const sess = sessionsStore.find(s => s.id === req.params.session_id);
    if (!sess) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Session not found: ${req.params.session_id}` } });
    }
    res.json(sess);
  });

  app.patch('/api/sessions/:session_id/cost', (req, res) => {
    const sess = sessionsStore.find(s => s.id === req.params.session_id);
    if (!sess) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Session not found: ${req.params.session_id}` } });
    }
    if (typeof req.body.cost_usd === 'number') {
      sess.cost_usd = req.body.cost_usd;
    }
    res.json(sess);
  });

  app.post('/api/sessions/:session_id/heartbeat', (req, res) => {
    const sess = sessionsStore.find(s => s.id === req.params.session_id);
    if (!sess) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: `Session not found: ${req.params.session_id}` } });
    }
    sess.last_heartbeat = new Date().toISOString();
    if (req.body.state) sess.state = req.body.state;
    if (req.body.detail) sess.detail = req.body.detail;
    res.json(sess);
  });

  app.post('/api/sessions/:session_id/kill', (req, res) => {
    const id = req.params.session_id;
    const sess = sessionsStore.find(s => s.id === id);
    if (sess) {
      sess.state = 'failed';
      sess.detail = 'Force-killed via API';
    }
    res.json({
      killed: true,
      sessionId: id,
      pids: sess ? [sess.pid] : [12345],
      errors: [],
      timestamp: new Date().toISOString(),
    });
  });

  // -------------------------------------------------------------
  // 6. Circuit Breaker (/api/breaker)
  // -------------------------------------------------------------
  app.get('/api/breaker', (req, res) => {
    res.json(circuitBreakerState);
  });

  app.post('/api/breaker/trip', (req, res) => {
    circuitBreakerState.tripped = true;
    circuitBreakerState.source = req.body.reason || 'MANUAL_TRIP';
    circuitBreakerState.error = req.body.reason || 'Manual circuit breaker trip';
    circuitBreakerState.detail = req.body.detail || 'Tripped by administrator via API';
    circuitBreakerState.tripped_at = new Date().toISOString();
    if (req.body.retryAfter) circuitBreakerState.retry_after = req.body.retryAfter;
    res.json(circuitBreakerState);
  });

  app.post('/api/breaker/reset', (req, res) => {
    circuitBreakerState.tripped = false;
    circuitBreakerState.source = '';
    circuitBreakerState.error = '';
    circuitBreakerState.detail = '';
    circuitBreakerState.tripped_at = null;
    res.json(circuitBreakerState);
  });

  app.post('/api/breaker/pause', (req, res) => {
    circuitBreakerState.paused = true;
    res.json(circuitBreakerState);
  });

  app.post('/api/breaker/resume', (req, res) => {
    circuitBreakerState.paused = false;
    res.json(circuitBreakerState);
  });

  app.get('/api/breaker/failure-recovery', (req, res) => {
    res.json({
      max_retries_per_model: circuitBreakerState.max_retries_per_model,
      retry_delay_seconds: circuitBreakerState.retry_delay_seconds,
      max_fallbacks: circuitBreakerState.max_fallbacks,
      push_back_to_pending: circuitBreakerState.push_back_to_pending,
      circuit_breaker_retry_after: circuitBreakerState.retry_after,
    });
  });

  app.post('/api/breaker/failure-recovery', (req, res) => {
    if (typeof req.body.max_retries_per_model === 'number') circuitBreakerState.max_retries_per_model = req.body.max_retries_per_model;
    if (typeof req.body.retry_delay_seconds === 'number') circuitBreakerState.retry_delay_seconds = req.body.retry_delay_seconds;
    if (typeof req.body.max_fallbacks === 'number') circuitBreakerState.max_fallbacks = req.body.max_fallbacks;
    if (typeof req.body.push_back_to_pending === 'boolean') circuitBreakerState.push_back_to_pending = req.body.push_back_to_pending;
    if (typeof req.body.circuit_breaker_retry_after === 'number') circuitBreakerState.retry_after = req.body.circuit_breaker_retry_after;

    res.json({
      max_retries_per_model: circuitBreakerState.max_retries_per_model,
      retry_delay_seconds: circuitBreakerState.retry_delay_seconds,
      max_fallbacks: circuitBreakerState.max_fallbacks,
      push_back_to_pending: circuitBreakerState.push_back_to_pending,
      circuit_breaker_retry_after: circuitBreakerState.retry_after,
    });
  });

  // -------------------------------------------------------------
  // 7. Receipts (/api/receipts)
  // -------------------------------------------------------------
  app.get('/api/receipts/:plan_id', (req, res) => {
    const planId = req.params.plan_id.startsWith('plan_') ? req.params.plan_id : `plan_${req.params.plan_id}`;
    const receipts = receiptsStore.filter(r => r.plan_id === planId);
    res.json(
      receipts.map(r => ({
        ...r,
        parsed_metadata: JSON.parse(r.metadata_json || '{}'),
      }))
    );
  });

  app.get('/api/receipts/:plan_id/raw', (req, res) => {
    const planId = req.params.plan_id.startsWith('plan_') ? req.params.plan_id : `plan_${req.params.plan_id}`;
    res.json(receiptsStore.filter(r => r.plan_id === planId));
  });

  app.get('/api/receipts/:plan_id/latest-type', (req, res) => {
    const planId = req.params.plan_id.startsWith('plan_') ? req.params.plan_id : `plan_${req.params.plan_id}`;
    const receipts = receiptsStore.filter(r => r.plan_id === planId);
    const latest = receipts.length > 0 ? receipts[receipts.length - 1].type : 'NONE';
    res.json({ plan_id: planId, latest_type: latest });
  });

  app.post('/api/receipts', (req, res) => {
    const r = req.body || {};
    const newRc = {
      id: r.id || `RCP-${Date.now()}`,
      plan_id: r.plan_id || 'plan_0053',
      type: r.type || 'PLAN_CREATE',
      agent_role: r.agent_role || 'planner',
      session_id: r.session_id || 'sess-1001',
      ticket_id: r.ticket_id || 'TCK-2026-0053',
      artifact_path: r.artifact_path || 'IMPLEMENTATION_PLANS/pending/my-plan.md',
      summary: r.summary || 'Inserted receipt',
      metadata_json: r.metadata_json || '{}',
      tokens_used: r.tokens_used || 1000,
      created_at: r.created_at || new Date().toISOString(),
    };
    receiptsStore.push(newRc);
    res.json({ ok: true, id: newRc.id, plan_id: newRc.plan_id });
  });

  app.delete('/api/receipts/:plan_id', (req, res) => {
    const planId = req.params.plan_id.startsWith('plan_') ? req.params.plan_id : `plan_${req.params.plan_id}`;
    const typesStr = (req.query.types as string) || '';
    const typesToDelete = typesStr.split(',').map(s => s.trim()).filter(Boolean);

    let countBefore = receiptsStore.length;
    for (let i = receiptsStore.length - 1; i >= 0; i--) {
      if (receiptsStore[i].plan_id === planId && (typesToDelete.length === 0 || typesToDelete.includes(receiptsStore[i].type))) {
        receiptsStore.splice(i, 1);
      }
    }
    const deletedCount = countBefore - receiptsStore.length;
    res.json({ deleted: deletedCount, plan_id: planId, types: typesToDelete });
  });

  // Vite middleware for dev or static server in prod
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`WRP Kernel Runtime & Control Plane running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
