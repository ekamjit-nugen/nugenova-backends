Feature: Recruitment — background spreadsheet imports
  Committing an Excel import answers immediately. Rows are saved one by one in
  the background, the dashboard shows the file with live counters, and rows with
  missing or invalid data are ignored with a reason.

  Scenario: starting an import answers at once and saves rows in the background
    Given an organization
    When the owner starts importing "Q3 candidates.xlsx" with 12 valid rows, a repeated row, a total line, a row without contact details and a row with an invalid email
    Then the import is accepted immediately as queued or processing
    And the import finishes with 12 new, 1 merged, 3 ignored and 0 errors out of 16 rows
    And the import list shows "Q3 candidates.xlsx" at 100 percent
    And every ignored row says why it was ignored

  Scenario: sending the same import again does not import twice
    Given an organization
    When the owner starts the same import twice with one idempotency key
    Then both requests return the same import
    And the organization has exactly 2 candidates once it finishes

  Scenario: parallel imports create a new opening only once
    Given an organization
    When the owner starts two imports at the same time that both use the new opening "Platform SRE"
    Then both imports finish
    And the organization has one "Platform SRE" opening holding all 4 candidates

  Scenario: an interrupted import resumes without duplicating saved rows
    Given an organization
    And an import whose worker stopped after saving the first of 3 rows
    When the worker picks up abandoned imports
    Then the import finishes with 3 rows processed
    And the person from the saved row exists only once

  @security
  Scenario: imports are permission-gated and org-scoped
    Given an organization
    And the owner has started an import
    Then an employee without recruitment access cannot start or read imports
    And the owner of another organization gets 404 on the import
    And a recruitment view-only member can follow progress but not start, cancel or retry

  Scenario: finished imports can be dismissed and only failed rows are retried
    Given an organization
    And the owner has started an import
    When the import has finished
    Then cancelling it is rejected as already finished
    And retrying it is rejected because nothing failed
    And dismissing it hides it from the dashboard list

  Scenario: duplicates can be discarded instead of merged
    Given an organization
    And an existing candidate "Ravi Menon" with email "ravi.menon@example.com" and company "Old Co"
    And an existing candidate "Sunita Rao" with phone "9811100022"
    When the owner imports with duplicates discarded: a row matching Ravi by email, a new person twice and a different "Sunita Rao"
    Then the import finishes with 1 new, 0 merged and 3 ignored
    And Ravi's profile still says "Old Co"
    And each discarded row names the candidate or row it duplicates

  Scenario: a file full of wrong data is refused instead of half-imported
    Given an organization
    When the owner tries to import a file where most rows have a broken email or no contact details
    Then the import is rejected, naming the rows to fix
    And no candidates were created and no import was started

