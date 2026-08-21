import { MAX_CONCURRENT_STREAMS } from '@cpe310/contracts';
import { useState } from 'react';

import { AddCameraWizard } from '../components/AddCameraWizard';
import { BrowserCameraPanel } from '../components/BrowserCameraPanel';
import { LiveView } from '../components/LiveView';
import { Banner, Button, Card } from '../components/ui';
import { usePermissions } from '../lib/permissions';
import { useCameras } from '../lib/queries';

/**
 * The camera wall.
 *
 * Deliberately the same LiveView component the Overview embeds rather than a second
 * implementation: reconnection, backoff, ticket minting, and the viewer cap are subtle
 * enough that two copies would drift, and the wall is exactly where a drifted copy
 * would be noticed last.
 */
export function CamerasPage() {
  const { canViewCameras, canReadAgents, canProvisionCameras, zones, isZoneRestricted } =
    usePermissions();
  const cameras = useCameras(canViewCameras);
  const [adding, setAdding] = useState<'device' | 'browser' | null>(null);

  const list = cameras.data ?? [];
  const streaming = list.filter((camera) => camera.streaming).length;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Cameras</h1>
        <span className="page-sub">
          {list.length === 0
            ? 'None in view'
            : `${streaming} of ${list.length} sending frames`}
        </span>
        {isZoneRestricted && (
          <span className="pill pill-brand" title="This credential is limited to specific zones">
            {zones.join(', ')}
          </span>
        )}
        <div className="page-head-actions">
          {canProvisionCameras && adding !== 'browser' && (
            <Button icon="camera" size="sm" onClick={() => setAdding('browser')}>
              Use this browser's camera
            </Button>
          )}
          {canReadAgents && adding !== 'device' && (
            <Button icon="plus" size="sm" onClick={() => setAdding('device')}>
              Add a device
            </Button>
          )}
        </div>
      </div>

      {adding === 'device' && (
        <Card flush>
          <AddCameraWizard onClose={() => setAdding(null)} />
        </Card>
      )}

      {adding === 'browser' && (
        <Card flush>
          <BrowserCameraPanel onClose={() => setAdding(null)} />
        </Card>
      )}

      <Banner tone="info" icon="camera">
        Only {MAX_CONCURRENT_STREAMS} feeds can run at once. Each open stream holds a connection
        for its whole life and browsers allow about six per site, so watching everything at once
        would stall the rest of the page rather than show you more.
      </Banner>

      <Card flush>
        <LiveView />
      </Card>
    </>
  );
}
