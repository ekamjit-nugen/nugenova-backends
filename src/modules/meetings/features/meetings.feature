Feature: Video meetings
  Members schedule or start video meetings, invite colleagues, and join a Jitsi
  room. Access is org-scoped: only the host, invited participants, and org
  admins can see or manage a meeting. Host-only actions are enforced.

  Scenario: a member schedules a meeting and invites a colleague
    Given an organization with two members
    When the host schedules a meeting inviting the colleague
    Then the meeting is created as scheduled with the colleague invited
    And the colleague receives a meeting invite notification

  Scenario: the meeting list only shows meetings the caller can access
    Given an organization with two members and a stranger
    When the host schedules a meeting inviting the colleague
    Then the colleague sees the meeting in their list
    And the stranger does not see the meeting in their list

  @security
  Scenario: an invited member can open the meeting but a stranger cannot
    Given an organization with two members and a stranger
    When the host schedules a meeting inviting the colleague
    Then the colleague can open the meeting
    And opening it as the stranger is forbidden

  Scenario: the first join flips a scheduled meeting to live
    Given an organization with two members
    When the host schedules a meeting inviting the colleague
    And the colleague joins the meeting
    Then the meeting becomes live and returns a room to join

  @security
  Scenario: only the host can cancel a meeting
    Given an organization with two members
    When the host schedules a meeting inviting the colleague
    Then the colleague cannot cancel the meeting
    And the host can cancel the meeting

  Scenario: the host adds a colleague to an ongoing meeting and duplicates are ignored
    Given an organization with two members and a stranger
    When the host starts an instant meeting
    And the host adds the colleague and the stranger
    Then two people are added to the meeting
    And adding the colleague again adds no one

  # Regression: the invite list came from /org/members, which needs
  # employees:view — so only owners/admins ever saw anyone to invite.
  Scenario: an employee can see who to invite and schedule a meeting with them
    Given an organization with two members and a stranger
    When the colleague lists the people they can invite
    Then the list includes the host and the stranger but not the colleague
    And the colleague can schedule a meeting inviting the stranger
    And the full member directory is still not open to the colleague

  @security
  Scenario: someone from another organization cannot be added to a meeting
    Given an organization with two members and a user from another organization
    When the host schedules a meeting inviting the colleague and the outsider
    Then only the colleague is a participant
    And the outsider receives no meeting notification
