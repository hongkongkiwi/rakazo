-- Additive and nullable: the optional page decider stays off until a bot pins both columns.
ALTER TABLE "bots"
  ADD COLUMN "pageDeciderProvider" TEXT,
  ADD COLUMN "pageDeciderModelId" TEXT;
