/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname
  },
  experimental: {
    // Default is 1MB; meeting recordings can be large video files, and
    // Deepgram's own hard limit (2GB, post ffmpeg normalization) is the
    // real ceiling downstream, so allow uploads well above that raw.
    serverActions: {
      bodySizeLimit: '5gb'
    }
  }
};

export default nextConfig;
