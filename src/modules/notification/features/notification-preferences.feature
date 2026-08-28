Feature: Notification preferences are enforced
  A user's Settings → Notifications choices actually gate delivery: turning a
  category off, or enabling Do Not Disturb, stops those notifications from being
  created — it's not cosmetic.

  Background:
    Given an organization with an owner and an employee

  Scenario: preferences default to everything on
    When the owner reads their notification preferences
    Then in-app is on and every category is on

  Scenario: turning off a category stops those notifications
    Given the owner turns off the attendance category
    When the employee submits a work-from-home request
    Then the owner receives no work-from-home notification

  Scenario: Do Not Disturb suppresses a non-urgent notification
    Given the owner enables Do Not Disturb
    When the employee submits a work-from-home request
    Then the owner receives no work-from-home notification

  Scenario: Do Not Disturb still lets an urgent notification through
    Given the employee enables Do Not Disturb allowing urgent
    And the employee has a pending work-from-home request
    When the owner approves the request
    Then the employee still receives the approval notification
