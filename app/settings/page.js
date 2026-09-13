import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import ApiKey from '@/app/lib/models/ApiKey';
import McpToken from '@/app/lib/models/McpToken';
import SettingsView from './SettingsView';

export const metadata = { title: 'Settings - Meeting Transcriber' };

export default async function SettingsPage() {
  const { userId } = await verifySession();

  await connectToDatabase();
  const user = await User.findById(userId).lean();
  const apiKeys = await ApiKey.find({ userId }).select('label createdAt lastUsedAt').sort({ createdAt: -1 }).lean();
  const mcpTokens = await McpToken.find({ userId }).select('label createdAt lastUsedAt').sort({ createdAt: -1 }).lean();

  return (
    <SettingsView
      userEmail={user?.email || ''}
      avatarUrl={user?.avatarUrl || null}
      hasGoogle={Boolean(user?.googleId)}
      hasPassword={Boolean(user?.passwordHash)}
      initialWebhooks={user?.webhooks || []}
      initialApiKeys={apiKeys.map((k) => ({
        id: String(k._id),
        label: k.label,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt || null
      }))}
      initialMcpTokens={mcpTokens.map((t) => ({
        id: String(t._id),
        label: t.label,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt || null
      }))}
    />
  );
}
