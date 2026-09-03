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
