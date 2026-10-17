/**
 * Compile-time only (tsconfig.rendezvous.json, Workers types): the narrow interfaces the Worker and the
 * Durable Object are written against, so Node can run them in tests, must accept the real runtime objects.
 */
import type { RegistryState } from './code-registry';
import type worker from './index';
import type { Env } from './index';

type Assert<T extends true> = T;

export type RuntimeChecks = [
  Assert<DurableObjectState extends RegistryState ? true : false>,
  Assert<{ CODE_REGISTRY: DurableObjectNamespace } extends Env ? true : false>,
  Assert<typeof worker extends ExportedHandler<Env> ? true : false>,
];
