'use server';

import { verifySession } from '@/app/lib/dal';
import { listMeetings } from '@/app/lib/meetings';

// Called imperatively from the dashboard's search box as the user types
// (not via a <form>), so it just re-runs the same query the initial page
// render uses.
export async function searchMeetings(query) {
  const { userId } = await verifySession();
  return listMeetings(userId, query);
}
