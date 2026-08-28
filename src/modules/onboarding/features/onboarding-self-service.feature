Feature: My Onboarding (employee self-service)
  A new hire reads their own onboarding, uploads requested documents, and ticks
  off self-serviceable tasks. Tasks owned by HR or IT can never be self-completed.

  Scenario: a hire reads their onboarding
    Given an organization with an onboarding for a hire
    When the hire reads their onboarding
    Then they see their documents and checklist

  Scenario: a hire uploads a document
    Given an organization with an onboarding for a hire
    When the hire uploads a file against a required document
    Then that document shows as uploaded and the onboarding is in progress

  Scenario: a hire completes a self-serviceable task
    Given an organization with an onboarding for a hire
    When the hire completes a welcome task
    Then that task shows as done

  Scenario: a hire cannot complete an IT task
    Given an organization with an onboarding for a hire
    When the hire tries to complete an IT-owned task
    Then the task completion is rejected as forbidden

  Scenario: a member with no onboarding gets an empty result
    Given an organization with an employee member
    When the employee reads their onboarding
    Then the onboarding result is empty
