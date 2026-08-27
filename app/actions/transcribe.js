'use server';

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { verifySession } from '@/app/lib/dal';
import { transcribeFile } from '@/app/lib/deepgram';
import { connectToDatabase } from '@/app/lib/db';
import Meeting from '@/app/lib/models/Meeting';

const fsp = fs.promises;
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export async function uploadAndTranscribe(formData) {
  const { userId } = await verifySession();

  const file = formData.get('file');
  if (!file || typeof file === 'string') {
    return { error: 'No file uploaded.' };
  }

  const uploadedPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${path.extname(file.name || '')}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fsp.writeFile(uploadedPath, buffer);

  try {
    const result = await transcribeFile(uploadedPath);

    await connectToDatabase();
    const meeting = await Meeting.create({
      userId,
      title: file.name,
      originalName: file.name,
      isVideo: result.isVideo,
      durationSeconds: result.durationSeconds,
      transcript: result.transcript,
      utterances: result.utterances,
      speakerNames: {}
    });

    return {
      id: String(meeting._id),
      originalName: file.name,
      isVideo: result.isVideo,
      durationSeconds: result.durationSeconds,
      transcript: result.transcript,
      utterances: result.utterances
    };
  } catch (error) {
    console.error(error);
    const isDeepgramError = error.message?.startsWith('Deepgram API error');
    const clientMessage = error.clientSafe || isDeepgramError
      ? error.message
      : 'Could not process this file. It may be corrupted, empty, or in an unsupported format.';
    return { error: clientMessage };
  }
}
