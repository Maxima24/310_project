import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'cpe310:isPublic';

/**
 * Exempts a route from ApiKeyGuard. Used only for `GET /health`, which must be
 * reachable by Docker's healthcheck and any load balancer without a key.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
