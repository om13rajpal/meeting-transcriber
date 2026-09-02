// Placeholder only - proves the Tauri + Vite + React + Tailwind v4 + copied
// shadcn/ui pipeline renders end to end, same verification pattern as
// extension/entrypoints/sidepanel/App.tsx's Task 1 scaffold. Replaced with
// the real tray/capture/settings UI in later tasks of this plan.
import { useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import "./App.css";

function App() {
  const [name, setName] = useState("");

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Meeting Transcriber</CardTitle>
          <CardDescription>Desktop companion scaffold</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            placeholder="Enter a name..."
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setName(e.currentTarget.value)
            }
          />
          <Button disabled={!name}>Continue</Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default App;
