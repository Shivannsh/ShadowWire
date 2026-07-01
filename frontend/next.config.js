/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/alice", destination: "/sender", permanent: true },
      { source: "/bob", destination: "/recipient", permanent: true },
      { source: "/buyer", destination: "/sender", permanent: true },
      { source: "/seller", destination: "/recipient", permanent: true },
    ];
  },
};

module.exports = nextConfig;
