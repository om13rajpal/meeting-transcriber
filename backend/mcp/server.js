const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const Meeting = require('../models/Meeting');

const SEARCH_SNIPPET_CONTEXT_CHARS = 60;
const MAX_SUMMARY_LENGTH = 4000;

// Escapes user input for safe use inside a RegExp - mirrors
// app/lib/meetings.js's escapeRegex() on the frontend. Duplicated rather
// than shared: this is a separate Node service with no access to the
// frontend's module graph.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mirrors app/lib/meetings.js's buildSnippet() - shows the transcript text
// around a search match instead of nothing, so a hit deep into a long
// meeting is still visible in the tool result. Returns null if the query
// isn't found in the transcript itself (it may have matched the title or
// a tag instead).
function buildSnippet(transcript, query) {
  if (!transcript || !query) return null;
  const idx = transcript.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT_CHARS);
  const end = Math.min(transcript.length, idx + query.length + SEARCH_SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < transcript.length ? '…' : '';
  return `${prefix}${transcript.slice(start, end).trim()}${suffix}`;
}

function toListItem(meeting) {
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    createdAt: meeting.createdAt.toISOString(),
    durationSeconds: meeting.durationSeconds || null,
    tags: meeting.tags || [],
    status: meeting.status || 'complete',
    hasSummary: Boolean(meeting.summary)
  };
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Builds a fresh McpServer scoped to one already-authenticated user. Every
// tool filters by this userId, never a client-supplied one - same rule as
// findOwnedMeeting()/markMeetingFailedCore() on the frontend. A meeting
// that exists but isn't this user's returns the same "not found" as one
// that doesn't exist at all, matching CLAUDE.md's ownership-leak rule.
function buildMcpServer(userId) {
  const server = new McpServer({ name: 'meeting-transcriber', version: '1.0.0' });

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description: 'Lists all of your meetings (newest first): id, title, date, duration, tags, status, and whether a summary already exists. No transcript text - use get_meeting for that.'
    },
    async () => {
      const meetings = await Meeting.find({ userId })
        .select('title originalName createdAt durationSeconds tags status summary')
        .sort({ createdAt: -1 })
        .lean();
      return jsonResult(meetings.map(toListItem));
    }
  );

  server.registerTool(
    'search_meetings',
    {
      title: 'Search meetings',
      description: 'Searches your meetings by title, filename, transcript content, and tags. Returns matches with a short snippet of transcript context.',
      inputSchema: { query: z.string().min(1) }
    },
    async ({ query }) => {
      const pattern = new RegExp(escapeRegex(query), 'i');
      const meetings = await Meeting.find({
        userId,
        $or: [{ title: pattern }, { originalName: pattern }, { transcript: pattern }, { tags: pattern }]
      })
        .select('title originalName createdAt durationSeconds tags status summary transcript')
        .sort({ createdAt: -1 })
        .lean();

      const results = meetings.map((m) => ({
        ...toListItem(m),
        snippet: buildSnippet(m.transcript || '', query)
      }));
      return jsonResult(results);
    }
  );

  server.registerTool(
    'get_meeting',
    {
      title: 'Get meeting transcript',
      description: 'Returns the full transcript and speaker-labeled utterances for one of your meetings, by id.',
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      const meeting = await Meeting.findOne({ _id: id, userId }).lean().catch(() => null);
      if (!meeting) return errorResult('Meeting not found.');

      return jsonResult({
        id: String(meeting._id),
        title: meeting.title || meeting.originalName || 'Untitled recording',
        createdAt: meeting.createdAt.toISOString(),
        durationSeconds: meeting.durationSeconds || null,
        tags: meeting.tags || [],
        transcript: meeting.transcript || '',
        utterances: (meeting.utterances || []).map((u) => ({
          speaker: u.speaker,
          start: u.start,
          end: u.end,
          transcript: u.transcript
        })),
        summary: meeting.summary || null
      });
    }
  );

  server.registerTool(
    'save_summary',
    {
      title: 'Save a summary',
      description: 'Saves a generated summary back onto one of your meetings, so it shows up on the meeting page.',
      inputSchema: { id: z.string().min(1), summary: z.string().min(1).max(MAX_SUMMARY_LENGTH) }
    },
    async ({ id, summary }) => {
      const updated = await Meeting.findOneAndUpdate(
        { _id: id, userId },
        { summary, summaryGeneratedAt: new Date() },
        { new: true }
      ).catch(() => null);
      if (!updated) return errorResult('Meeting not found.');

      return jsonResult({ id: String(updated._id), summaryGeneratedAt: updated.summaryGeneratedAt.toISOString() });
    }
  );

  return server;
}

module.exports = { buildMcpServer };
