import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import Settings from './Settings';

type State = { activeMeetingTabId: number | null; platform: 'meet' | 'teams' | null; recording: boolean };

export default function App() {
  const [state, setState] = useState<State>({ activeMeetingTabId: null, platform: null, recording: false });
  const [showSettings, setShowSettings] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s) => s && setState(s));
    const listener = (message: any) => {
      if (message.type === 'STATE_CHANGED') setState(message.state);
      if (message.type === 'RECORDING_INTERRUPTED') setInterrupted(true);
      if (message.type === 'UPLOAD_STATUS') setUploadStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function handleStart() {
    setInterrupted(false);
    setUploadStatus(null);
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
  }

  function handleStop() {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
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
          {uploadStatus && <p className="text-xs text-muted-foreground">{uploadStatus}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
