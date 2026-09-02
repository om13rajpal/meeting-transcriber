// Placeholder only - proves the WXT + React + Tailwind v4 + copied shadcn/ui
// pipeline renders end to end. Replaced fully in Task 5 with the real
// capture UI.
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function App() {
  return (
    <div className="p-4 text-sm">
      <Card>
        <CardHeader>
          <CardTitle>Meeting Transcriber</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2">
          <Badge>Scaffold</Badge>
          <Button size="sm">Continue</Button>
        </CardContent>
      </Card>
    </div>
  );
}
