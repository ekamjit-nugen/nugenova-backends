Feature: Recruitment — client leads, submissions, talent pool and suggestions
  Recruiters manage Sales leads (client demand) from the Recruitment panel,
  submit candidates against a lead's requirements and track every client-side
  step. Candidates that are not in an opening or a lead sit in the talent pool,
  and the system suggests where they fit.

  Scenario: the downloadable sample CVs parse
    Given an organization
    When the owner uploads the sample CV as PDF and as DOCX and parses them without AI
    Then both parses extract the sample email, phone and 72 months experience

  Scenario: submitting a candidate to a lead requirement starts work on it
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow"
    When the owner submits the candidate to that requirement
    Then the submission is "shortlisted" and the requirement is "in_progress"
    And submitting the same candidate again is rejected as a duplicate

  Scenario: the full client path is tracked and fills the requirement
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow"
    And the candidate is submitted to that requirement
    When the owner moves the submission straight to "onboarded"
    Then the move is rejected as a bad request
    When the owner withdraws the submission without a reason
    Then the move is rejected as a bad request
    When the owner moves the submission through "submitted, client_screening, client_selected, onboarded"
    Then the requirement is "fulfilled" and the submission has 5 events
    And the candidate timeline records the client steps
    And the lead workspace shows 1 onboarded submission

  Scenario: a client interview is linked to the submission
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow"
    And the candidate is submitted to that requirement
    And the owner marks the submission "submitted"
    When the owner schedules a client interview for the submission
    Then the submission moves to "client_interview"
    And the interview is a client round labelled with the client

  @security
  Scenario: lead workspace access is permission-gated and money is masked
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow"
    And the candidate is submitted to that requirement
    Then an employee without recruitment access gets 403 on the lead list
    And the owner of another organization gets 404 on the lead
    And a recruitment view-only member sees no lead value, cost or margin and cannot move the submission

  Scenario: the talent pool holds only unassigned candidates
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow"
    And a candidate "Meera Iyer" with skills "React, TypeScript"
    And the first candidate is submitted to that requirement
    When the owner lists the talent pool
    Then only "Meera Iyer" is in the talent pool and the pool counts agree

  Scenario: suggestions rank the best-fitting requirement first
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    And the lead also needs a "Frontend Developer" with skills "React, TypeScript"
    And a candidate "Meera Iyer" with skills "React, TypeScript"
    When the owner asks for suggestions for the candidate
    Then the first suggestion is the "Frontend Developer" requirement
    And matches for that requirement rank "Meera Iyer" first

  Scenario: an opening can be raised from a requirement
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    When the owner creates an opening from the requirement
    Then the opening carries the requirement's skills and is linked to the lead
    And creating it again is rejected as a conflict

  Scenario: importing rows with a Lead column shortlists them and fills the talent pool
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    When the owner imports one row for the lead requirement and one row with no opening or lead
    Then the import reports 1 submission and 1 talent-pool candidate
    And the lead workspace lists the imported candidate as "shortlisted"

  Scenario: lead details, requirements, follow-ups and notes are managed from Recruitment
    Given an organization with a lead "Acme Corp" needing 1 "Senior Data Engineer" with skills "PySpark, SQL"
    When the owner edits the requirement to 2 positions needed by "2026-12-01" and adds a follow-up and a call note
    Then the lead workspace shows the requirement with 2 positions, the follow-up and the note

  Scenario: one candidate runs in several client leads at different stages at the same time
    Given an organization with 4 client leads each needing a "Data Engineer"
    And a candidate "Rohan Verma" with skills "PySpark, SQL, Airflow" in that organization
    When the owner submits the candidate to all 4 leads
    And moves 3 of them to "client_screening" and 1 to "client_interview"
    Then the candidate profile shows 4 active submissions with 3 in "client_screening" and 1 in "client_interview"
    And the candidate appears once in the "submitted" pool with all 4 submissions

  Scenario: the import preview flags duplicates by name, email and phone before anything is saved
    Given an organization with an existing candidate "Akash Shaw" with email "akash.sample@example.com" and phone "9804753101"
    When the owner previews an import with rows matching by email, by phone, by name only and repeating within the file
    Then the preview marks the email and phone rows as merged into "Akash Shaw"
    And the name-only row is flagged for review
    And the repeated row is marked as the same person as its earlier row
    And the summary counts 3 merged and 1 flagged duplicates with nothing saved
