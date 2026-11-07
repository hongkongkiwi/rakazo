-- A conversation can run on its own model, picked while chatting. Null follows the bot.
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "modelProvider" TEXT;
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "modelId" TEXT;
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "thinkingLevel" TEXT;
