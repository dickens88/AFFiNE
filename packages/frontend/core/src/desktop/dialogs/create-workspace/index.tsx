import { Button, ConfirmModal, notify, RowInput } from '@affine/component';
import { useIsPiscesSSO } from '@affine/core/components/hooks/affine/use-is-pisces-sso';
import { useAsyncCallback } from '@affine/core/components/hooks/affine-async-hooks';
import {
  AuthService,
  type Server,
  ServersService,
} from '@affine/core/modules/cloud';
import {
  type DialogComponentProps,
  type GLOBAL_DIALOG_SCHEMA,
  GlobalDialogService,
} from '@affine/core/modules/dialogs';
import { WorkspacesService } from '@affine/core/modules/workspace';
import { buildShowcaseWorkspace } from '@affine/core/utils/first-app-data';
import { useI18n } from '@affine/i18n';
import track from '@affine/track';
import { FrameworkScope, useLiveData, useService } from '@toeverything/infra';
import { useCallback, useState } from 'react';

import * as styles from './index.css';
import { ServerSelector } from './server-selector';

const FormSection = ({
  label,
  input,
}: {
  label: string;
  input: React.ReactNode;
}) => {
  return (
    <section className={styles.section}>
      <label className={styles.label}>{label}</label>
      {input}
    </section>
  );
};

export const CreateWorkspaceDialog = ({
  serverId,
  close,
  ...props
}: DialogComponentProps<GLOBAL_DIALOG_SCHEMA['create-workspace']>) => {
  const t = useI18n();

  // In Pisces SSO mode every workspace is backed by the self-hosted server,
  // so force the default cloud server and hide the workspace-type selector.
  const isPiscesSSO = useIsPiscesSSO();

  const [workspaceName, setWorkspaceName] = useState('');
  const [inputServerId, setInputServerId] = useState(
    serverId ?? 'affine-cloud'
  );

  const serversService = useService(ServersService);
  const server = useLiveData(
    inputServerId ? serversService.server$(inputServerId) : null
  );

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) close();
    },
    [close]
  );

  return (
    <ConfirmModal
      open
      onOpenChange={onOpenChange}
      title={t['com.affine.nameWorkspace.title']()}
      description={t['com.affine.nameWorkspace.description']()}
      cancelText={t['com.affine.nameWorkspace.button.cancel']()}
      closeButtonOptions={{
        ['data-testid' as string]: 'create-workspace-close-button',
      }}
      contentOptions={{}}
      childrenContentClassName={styles.content}
      customConfirmButton={() => {
        return (
          <FrameworkScope scope={server?.scope}>
            <CustomConfirmButton
              workspaceName={workspaceName}
              server={server}
              onCreated={res =>
                close({ metadata: res.meta, defaultDocId: res.defaultDocId })
              }
            />
          </FrameworkScope>
        );
      }}
      {...props}
    >
      <FormSection
        label={t['com.affine.nameWorkspace.subtitle.workspace-name']()}
        input={
          <RowInput
            autoFocus
            className={styles.input}
            data-testid="create-workspace-input"
            placeholder={t['com.affine.nameWorkspace.placeholder']()}
            maxLength={64}
            minLength={0}
            onChange={setWorkspaceName}
          />
        }
      />

      {isPiscesSSO ? null : (
        <FormSection
          label={t['com.affine.nameWorkspace.subtitle.workspace-type']()}
          input={
            <ServerSelector
              className={styles.select}
              selectedId={inputServerId}
              onChange={setInputServerId}
            />
          }
        />
      )}
    </ConfirmModal>
  );
};

const CustomConfirmButton = ({
  workspaceName,
  server,
  onCreated,
}: {
  workspaceName: string;
  server?: Server | null;
  onCreated: (res: Awaited<ReturnType<typeof buildShowcaseWorkspace>>) => void;
}) => {
  const t = useI18n();
  const [loading, setLoading] = useState(false);

  const session = useService(AuthService).session;
  const loginStatus = useLiveData(session.status$);
  const isPiscesSSO = useIsPiscesSSO();
  const globalDialogService = useService(GlobalDialogService);
  const workspacesService = useService(WorkspacesService);

  const openSignInModal = useCallback(() => {
    globalDialogService.open('sign-in', { server: server?.baseUrl });
  }, [globalDialogService, server?.baseUrl]);

  const handleConfirm = useAsyncCallback(async () => {
    if (loading) return;
    setLoading(true);
    track.$.$.$.createWorkspace({
      flavour: !server ? 'local' : 'affine-cloud',
    });

    // this will be the last step for web for now
    // fix me later
    try {
      const res = await buildShowcaseWorkspace(
        workspacesService,
        server?.id ?? 'local',
        workspaceName
      );
      onCreated(res);
    } catch (e) {
      console.error(e);
      notify.error({
        title: 'Failed to create workspace',
        message: 'please try again later.',
      });
    } finally {
      setLoading(false);
    }
  }, [loading, onCreated, server, workspaceName, workspacesService]);

  const handleCheckSessionAndConfirm = useAsyncCallback(async () => {
    if (server && loginStatus !== 'authenticated') {
      if (isPiscesSSO) {
        // In Pisces SSO mode authentication is transparent. The credential may
        // still be propagating, so trigger a revalidation and wait for the
        // session — showing a spinner and bailing out with a clear error
        // instead of hanging the button indefinitely.
        setLoading(true);
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 15000);
        try {
          session.revalidate();
          await session.waitForAuthenticated(abort.signal);
        } catch {
          notify.error({
            title: 'Failed to create workspace',
            message: 'Authentication is not ready yet, please try again.',
          });
          return;
        } finally {
          clearTimeout(timeout);
          setLoading(false);
        }
      } else {
        return openSignInModal();
      }
    }
    handleConfirm();
  }, [
    handleConfirm,
    isPiscesSSO,
    loginStatus,
    openSignInModal,
    server,
    session,
  ]);

  return (
    <Button
      disabled={!workspaceName}
      data-testid="create-workspace-create-button"
      variant="primary"
      onClick={handleCheckSessionAndConfirm}
      loading={loading}
    >
      {t['com.affine.nameWorkspace.button.create']()}
    </Button>
  );
};
