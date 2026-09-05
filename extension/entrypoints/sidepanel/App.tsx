import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import Settings from './Settings';
import RecentRecordings from './RecentRecordings';

type State = { activeMeetingTabId: number | null; platform: 'meet' | 'teams' | null; recording: boolean };

export default function App() {
  const [state, setState] = useState<State>({ activeMeetingTabId: null, platform: null, recording: false });
  const [showSettings, setShowSettings] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [recordingsRefreshSignal, setRecordingsRefreshSignal] = useState(0);

  function refreshRetainedRecording() {
    chrome.storage.session.get<{ hasRetainedRecording?: boolean }>(['hasRetainedRecording']).then((r) => {
      setCanRetry(Boolean(r.hasRetainedRecording));
    });
  }

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s) => s && setState(s));
    // Restores the *last* outcome on every panel open, not just while it
    // happens to be open live - the panel being closed during an actual
    // meeting (the normal case) used to mean any status, success or
    // failure, was broadcast into the void and lost for good.
    chrome.storage.session.get<{ lastUploadStatus?: string | null }>(['lastUploadStatus']).then((r) => {
      if (r.lastUploadStatus) setUploadStatus(r.lastUploadStatus);
    });
    refreshRetainedRecording();
    const listener = (message: any) => {
      if (message.type === 'STATE_CHANGED') setState(message.state);
      if (message.type === 'RECORDING_INTERRUPTED') setInterrupted(true);
      if (message.type === 'UPLOAD_STATUS') {
        setUploadStatus(message.status);
        refreshRetainedRecording();
        setRecordingsRefreshSignal((n) => n + 1);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function handleStart() {
    setInterrupted(false);
    setUploadStatus(null);
    setStartError(null);
    // The background script answers every start attempt, success or failure
    // (a missing activeTab grant, a denied microphone, a tab that went away).
    // Ignoring that response is what made every one of those failures look
    // identical from here: a click that appears to do nothing at all.
    chrome.runtime.sendMessage({ type: 'START_RECORDING' }, (response) => {
      if (chrome.runtime.lastError) {
        setStartError(chrome.runtime.lastError.message || 'Could not reach the extension background script.');
        return;
      }
      if (response?.error) setStartError(response.error);
    });
  }

  function handleStop() {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  }

  function handleRetry() {
    setUploadStatus('Retrying upload...');
    chrome.runtime.sendMessage({ type: 'RETRY_UPLOAD' });
  }

  if (showSettings) return <Settings onClose={() => setShowSettings(false)} />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-medium">Meeting Transcriber</h1>
        <Button variant="ghost" size="sm" onClick={() => setShowSettings(true)}>Settings</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {state.activeMeetingTabId ? `${state.platform === 'meet' ? 'Google Meet' : 'Teams'} call detected` : 'No call detected'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {interrupted && <Badge variant="destructive">Recording stopped - meeting tab was closed</Badge>}
          {state.recording ? (
            <Button variant="destructive" onClick={handleStop}>Stop recording</Button>
          ) : (
            <Button onClick={handleStart} disabled={!state.activeMeetingTabId}>Start recording</Button>
          )}
          {startError && <p className="text-xs text-destructive">{startError}</p>}
          {uploadStatus && <p className="text-xs text-muted-foreground">{uploadStatus}</p>}
          {canRetry && !state.recording && (
            <Button variant="outline" size="sm" onClick={handleRetry}>Retry upload</Button>
          )}
        </CardContent>
      </Card>

      <RecentRecordings refreshSignal={recordingsRefreshSignal} />
    </div>
  );
}
