Feature: Activity feed + retention
  A curated, org-scoped feed of what members do. Admins/owners see the whole
  org; members see only their own activity. Activity logs older than 15 days are
  archived to the owner by email and purged.

  Scenario: a member's action is captured in the activity feed
    Given an organization with an owner and a member
    When the owner schedules a meeting
    Then the owner's activity feed shows a meetings event

  @security
  Scenario: members only see their own activity
    Given an organization with an owner and a member
    When the owner schedules a meeting
    Then the member's activity feed does not show the owner's event

  Scenario: retention archives old logs to the owner and purges them
    Given an organization with an owner and a member
    And there are activity logs older than 15 days
    When the owner runs retention
    Then the old logs are emailed to the owner and removed
