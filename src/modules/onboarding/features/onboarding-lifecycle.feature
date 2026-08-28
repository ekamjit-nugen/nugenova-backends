Feature: Employee onboarding lifecycle (HR)
  HR starts onboarding for a member; requirements are seeded from the org's
  onboarding policy config. HR verifies or rejects uploaded documents, completes
  or cancels the onboarding, and a policy edit reconciles onto in-progress
  onboardings on the next read.

  Scenario: HR initiates onboarding for a member
    Given an organization with an employee member
    When the owner initiates onboarding for that member
    Then an onboarding is created seeded with documents and a checklist
    And the member appears in the active onboarding list

  Scenario: a second onboarding for the same member is blocked
    Given an organization with an employee member
    And the owner has initiated onboarding for that member
    When the owner initiates onboarding for that member again
    Then the second initiate is rejected as a bad request

  Scenario: HR verifies an uploaded document
    Given an organization with an onboarding whose member has uploaded a document
    When the owner verifies that document
    Then the document is marked verified

  Scenario: HR rejects an uploaded document with a note
    Given an organization with an onboarding whose member has uploaded a document
    When the owner rejects that document with a note
    Then the document is marked rejected with the note

  Scenario: a policy edit reconciles onto an in-progress onboarding
    Given an organization with an employee member
    And the owner has initiated onboarding for that member
    When the owner adds a passport to the onboarding requirements
    And the owner reads that onboarding
    Then the onboarding now includes a pending passport document

  Scenario: HR completes an onboarding
    Given an organization with an employee member
    And the owner has initiated onboarding for that member
    When the owner completes that onboarding
    Then the onboarding status is completed
    And re-initiating onboarding for that member is blocked

  @security
  Scenario: an employee cannot read the onboarding list
    Given an organization with an employee member
    When the employee requests the onboarding list
    Then the onboarding list request is rejected as forbidden

  Scenario: an HR role granting employees:edit can manage onboarding
    Given an organization with a member whose custom role grants employees:edit
    When that HR member requests the onboarding list
    Then the onboarding list is returned

  Scenario: filling in your profile auto-completes the profile checklist task
    Given an organization with an onboarding for a member
    When the member fills in their profile
    Then their "Complete your profile" task is done on the next read

  Scenario: the profile task follows the owner's required-fields configuration
    Given an organization that requires only the department profile field
    And an onboarding for a member of that org
    When the member fills in only their department
    Then their "Complete your profile" task is done on the next read
