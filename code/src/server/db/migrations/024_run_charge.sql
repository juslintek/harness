-- A run with no member of its own (an interview) is charged to this member's budgets.
ALTER TABLE runs ADD COLUMN charged_to TEXT;
