import { DefaultServerService } from '@affine/core/modules/cloud';
import { ServerFeature } from '@affine/graphql';
import { useLiveData, useService } from '@toeverything/infra';

/**
 * Whether the default server delegates authentication to Pisces SSO.
 *
 * In Pisces deployments sign-in happens transparently and every workspace is
 * backed by the self-hosted server, so the UI must hide the sign-in and
 * "enable cloud" prompts that don't apply.
 */
export const useIsPiscesSSO = (): boolean => {
  const defaultServerService = useService(DefaultServerService);
  const features = useLiveData(defaultServerService.server.config$)?.features;
  return features?.includes(ServerFeature.PiscesSSO) ?? false;
};
