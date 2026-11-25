-- v2: hooks no longer talk to the Worker, so hook tokens are gone. Sessions read and write
-- only through the MCP connector, which authenticates with OAuth.
DROP TABLE IF EXISTS tokens;
