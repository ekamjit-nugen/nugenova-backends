Feature: Chat / messaging
  Members hold conversations (direct, group, channel) and exchange messages.
  Every conversation and message is scoped to the organization AND the caller:
  no user can read another org's messages, and no user can read a conversation
  they are not a participant of.

  Scenario: a member starts a direct conversation and sends a message
    Given an organization with two members
    When the first member opens a direct conversation with the second
    And the first member sends "Hello there" to it
    Then the message is stored and returned with an id
    And listing the conversation's messages returns "Hello there"

  Scenario: the other participant can read the messages
    Given an organization with two members and a direct conversation between them
    When the first member sends "Standup at 10" to it
    Then the second member can list the conversation and see "Standup at 10"

  Scenario: an empty text message is rejected
    Given an organization with two members and a direct conversation between them
    When the first member sends a blank message
    Then the send is rejected as a bad request

  Scenario: a group conversation lists for all its members
    Given an organization with two members
    When the first member creates a group with the second
    Then both members see the group in their conversation list

  Scenario: mentioning a participant persists the mention and notifies them
    Given an organization with three members and a group conversation between two of them
    When the first member sends a message mentioning the second and the non-participant third
    Then the stored message persists both mentions
    And the mentioned participant receives a chat mention notification
    And the non-participant does not receive a notification

  Scenario: a pinned message shows up in the conversation's pinned list
    Given an organization with two members and a direct conversation between them
    When the first member sends "Pin me" and pins it
    Then the conversation's pinned list contains "Pin me"

  Scenario: forwarding a message copies it into another conversation the user is in
    Given an organization with two members and a direct conversation between them
    And the first member is also in a group conversation
    When the first member forwards a message from the direct into the group
    Then the group has a forwarded copy carrying the original's forwardedFrom

  Scenario: a bookmarked message appears in the owner's bookmarks and not another user's
    Given an organization with two members and a direct conversation between them
    When the first member sends "Save me" and bookmarks it
    Then the first member's bookmarks include "Save me"
    And the second member's bookmarks do not include it

  Scenario: a member uploads a file, sends it, and participants can fetch it
    Given an organization with two members and a direct conversation between them
    When the first member uploads a file and sends it as a message
    Then the message carries the attachment fields
    And the first member can fetch the file
    And the second member can fetch the file
    And an unauthenticated fetch is rejected

  @security
  Scenario: a non-participant cannot fetch a conversation's file
    Given an organization with two members and a direct conversation between them
    And a third member of the same organization
    When the first member uploads a file and sends it as a message
    Then the third member is refused the file as not found

  @security
  Scenario: a member cannot read a conversation they are not part of
    Given an organization with two members and a direct conversation between them
    And a third member of the same organization
    When the third member tries to read that conversation
    Then the read is rejected as forbidden

  @security
  Scenario: one organization cannot see another organization's messages
    Given two separate organizations each with a conversation and a message
    When a member of the first organization tries to read the second's conversation
    Then the read is rejected as not found
    And the first organization's conversation list does not include the second's
