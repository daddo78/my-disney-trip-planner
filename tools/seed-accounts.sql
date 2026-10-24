-- One-time: give the trips from before accounts existed (no owner yet) to Brittany (owner) and Dan.
-- Their account ids are "brittany" and "dan", the same ids the old hearts and pros & cons use.
-- Fill in the emails when running it (they aren't kept in the repo), e.g.:
--   sed -e 's/{{BRITTANY_EMAIL}}/her@example.com/' -e 's/{{DAN_EMAIL}}/him@example.com/' tools/seed-accounts.sql > seed.sql
--   npx wrangler@4 d1 execute disney-trip-planner --remote --file seed.sql
INSERT OR IGNORE INTO users (id, email, name, link, created) VALUES
  ('brittany', lower('{{BRITTANY_EMAIL}}'), 'Brittany', lower(hex(randomblob(12))), datetime('now')),
  ('dan', lower('{{DAN_EMAIL}}'), 'Dan', lower(hex(randomblob(12))), datetime('now'));
INSERT OR IGNORE INTO friends (a, b) VALUES ('brittany', 'dan'), ('dan', 'brittany');
INSERT OR IGNORE INTO members (trip, user_id, owner) SELECT id, 'brittany', 1 FROM docs WHERE coll = 'trips' AND deleted = 0 AND json_extract(data, '$.owner') IS NULL;
INSERT OR IGNORE INTO members (trip, user_id, owner) SELECT id, 'dan', 0 FROM docs WHERE coll = 'trips' AND deleted = 0 AND json_extract(data, '$.owner') IS NULL;
-- Link the Brittany and Dan rows on each trip's Who's going to their accounts.
UPDATE docs SET data = json_set(data, '$.owner', 'brittany', '$.people', (
    SELECT json_group_array(CASE json_extract(p.value, '$.name')
      WHEN 'Brittany' THEN json_set(p.value, '$.uid', 'brittany')
      WHEN 'Dan' THEN json_set(p.value, '$.uid', 'dan')
      ELSE json(p.value) END)
    FROM json_each(docs.data, '$.people') AS p)),
  updated = (SELECT MAX(updated) FROM docs) + 1
WHERE coll = 'trips' AND deleted = 0 AND json_extract(data, '$.owner') IS NULL AND json_type(data, '$.people') = 'array';
