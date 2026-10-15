import { createAgentService } from '../agents/service.js';
import { createAgentTools } from '../agents/tools.js';
import { createMiAgenteRouter } from './miAgente.js';
import { createAgentToolsRouter } from './agentTools.js';

/** Only registers routes; schema initialization is an explicit deployment task. */
export function mountPersonalAgentModules(app, deps, {
  createService = createAgentService,
  createTools = createAgentTools,
  createManagementRouter = createMiAgenteRouter,
  createToolsRouter = createAgentToolsRouter,
  env = process.env,
} = {}) {
  const { query, withTransaction, withAuth } = deps;
  const enabled = deps.personalAgentsEnabled === undefined
    ? env.PERSONAL_AGENTS_ENABLED === '1' : deps.personalAgentsEnabled === true;
  const canonicalOrigin = deps.agentCanonicalOrigin ?? env.AGENT_CANONICAL_ORIGIN ?? '';
  const service = createService({ query, withTransaction, enabled, canonicalOrigin });
  const tools = createTools({ query, withTransaction });
  app.use('/api/mi-agente', createManagementRouter({ withAuth, service, canonicalOrigin }));
  app.use('/api/agent/v1', createToolsRouter({ service, tools }));
  return { service, tools };
}
