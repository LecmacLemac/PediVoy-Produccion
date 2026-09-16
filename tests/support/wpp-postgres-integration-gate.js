import { execFileSync } from 'node:child_process';

export const POSTGRES_INTEGRATION_SKIP_REASON =
  'Requires a local postgres:16 Docker image and Unix-socket daemon';

function dockerEnvironment(env, host) {
  const dockerEnv = { ...env, DOCKER_HOST: host };
  delete dockerEnv.DOCKER_CONTEXT;
  return dockerEnv;
}

export function resolvePostgresIntegrationGate({
  env = process.env,
  exec = execFileSync,
} = {}) {
  try {
    const configuredHost = env.DOCKER_HOST;
    const contextHost = configuredHost || exec(
      'docker', ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'],
      { encoding: 'utf8', timeout: 10_000, env },
    ).trim();
    if (!contextHost.startsWith('unix://')) {
      throw new Error(`Docker endpoint is not a local Unix socket: ${contextHost}`);
    }
    const dockerEnv = dockerEnvironment(env, contextHost);
    exec('docker', ['info'], { stdio: 'ignore', timeout: 10_000, env: dockerEnv });
    exec('docker', ['image', 'inspect', 'postgres:16'], {
      stdio: 'ignore', timeout: 10_000, env: dockerEnv,
    });
    return { host: contextHost, skip: false };
  } catch (cause) {
    if (env.REQUIRE_WPP_PG_INTEGRATION === '1') {
      throw new Error(`${POSTGRES_INTEGRATION_SKIP_REASON}; required by REQUIRE_WPP_PG_INTEGRATION=1`, {
        cause,
      });
    }
    return { host: null, skip: POSTGRES_INTEGRATION_SKIP_REASON };
  }
}
