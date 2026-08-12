/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `cheerio` and `nodemailer` are server-only CommonJS packages. Telling Next to treat
  // them as external keeps them out of the bundler and avoids "Module not found: fs"
  // style errors when the API routes are compiled for the Node.js serverless runtime.
  experimental: {
    serverComponentsExternalPackages: ['cheerio', 'nodemailer'],
  },
};

module.exports = nextConfig;
