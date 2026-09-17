Feature: Recruitment — talent pool, pipeline, interviews and offers
  An organization tracks candidates sourced from Cutshort and elsewhere: rich
  profiles with CVs, job openings with a stage pipeline, interview rounds with
  scorecards, offers, and a spreadsheet import for the team's legacy Excel.
  Everything is org-scoped and gated on the `recruitment` permission; an
  assigned interviewer gets a limited view of the candidate they interview.

  Scenario: an owner adds a candidate to an opening and finds them by skill
    Given an organization with an opening "Data Engineer"
    When the owner adds candidate "Ajoy Dutta" with skill "PySpark" to the opening
    Then searching candidates for "pyspark" returns "Ajoy Dutta"
    And the opening board shows the candidate in the default stage

  @security
  Scenario: the same email cannot be entered twice
    Given an organization with a candidate "Akash Shaw" using email "akash.pshaw524@gmail.com"
    When the owner adds candidate "A. Shaw" using email " Akash.PShaw524@Gmail.com "
    Then the create is rejected as a duplicate pointing at the existing candidate

  @security
  Scenario: a member without the recruitment permission is refused
    Given an organization with an employee member
    When the employee lists candidates
    Then the request is rejected as forbidden

  @security
  Scenario: another organization cannot read a candidate
    Given an organization with a candidate "Akash Shaw" using email "akash.pshaw524@gmail.com"
    When the owner of a different organization opens that candidate
    Then the candidate is not found

  Scenario: moving a candidate to Rejected requires a reason and is recorded
    Given an organization with candidate "Zaid Alam" in opening "GenAI Engineer"
    When the owner moves the application to "Rejected" without a reason
    Then the move is rejected as a bad request
    When the owner moves the application to "Rejected" with reason "Skills mismatch"
    Then the application status is "rejected" with 2 stage events

  @security
  Scenario: a view-only recruiter cannot see salary figures
    Given an organization with a candidate whose current CTC is 1200000
    And a member whose role grants recruitment view only
    When that member opens the candidate
    Then the CTC is hidden from them

  Scenario: an interviewer sees only their interview and submits a scorecard
    Given an organization with candidate "Zaid Alam" in opening "GenAI Engineer"
    And an interview "Technical Round" assigned to an employee
    When the interviewer lists their interviews
    Then they see "Technical Round"
    And they can open the candidate with limited access
    When the interviewer submits a "yes" scorecard rating every criterion 4
    Then the interview is completed with an overall rating of 4
    And a different employee cannot open that interview

  Scenario: importing the legacy spreadsheet merges people across sheets
    Given an organization
    When the owner dry-runs an import of rows from two role sheets sharing one email
    Then the dry run reports 2 created, 1 merged and 2 openings to create
    And nothing was written
    When the owner commits the same import
    Then the org has 2 candidates and "Data Engineer" has 2 applications
    And "Akash Shaw" has 108 months experience and a cleaned company

  Scenario: a CV is uploaded with typed-in details and shown as stored
    Given an organization with an opening "BI Developer"
    When the owner uploads a text CV
    Then the CV-reading endpoint no longer exists
    When the owner saves the candidate from the CV into the opening
    Then the candidate has the CV as primary, with only the typed-in details
    And the CV can be opened in the portal exactly as uploaded

  Scenario: an accepted offer hires the candidate and fills the opening
    Given an organization with candidate "Zaid Alam" in opening "GenAI Engineer"
    When the owner drafts, sends and accepts an offer
    Then the application is hired and the opening is filled

  Scenario: merging duplicate profiles keeps one candidate
    Given an organization with two profiles of the same person
    When the owner merges the duplicate into the primary
    Then only the primary remains with the duplicate's phone and applications
