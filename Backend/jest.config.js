/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  transform: { "^.+\\.ts$": ["@swc/jest"] },
  moduleFileExtensions: ["ts", "js", "json"],
};
