Feature: In-app notifications
  Notifications are delivered per recipient. A user only ever sees their own,
  every notification a user is sent is tracked in their panel, and each carries a
  routing hint so a tap can open the respective page. Real events (a WFH request
  and its review) drive the notifications.

  Background:
    Given an organization with an owner and two employees

  Scenario: a new request notifies the approvers but not the requester or bystanders
    When the first employee requests work-from-home
    Then the owner has an unread "wfh_request_submitted" notification
    And the requesting employee has no notifications
    And the second employee has no notifications

  Scenario: reviewing a request notifies the requester and is tracked with a route
    Given the first employee has a pending WFH request
    When the owner approves the request
    Then the first employee has a "wfh_request_reviewed" notification
    And that notification carries an actionUrl to the attendance page

  Scenario: a user only sees their own notifications
    Given the first employee has a pending WFH request
    When the owner approves the request
    Then the owner's inbox does not contain the review notification
    And the first employee's inbox does not contain the submission notification

  Scenario: another user cannot mark someone else's notification read
    Given the first employee has a pending WFH request
    And the owner has an unread submission notification
    When the first employee tries to mark the owner's notification read
    Then the owner's notification is still unread

  Scenario: a recipient can mark their notifications read and clear them
    Given the first employee has a pending WFH request
    And the owner has an unread submission notification
    When the owner marks all notifications read
    Then the owner's unread count is zero
    And the owner can clear read notifications so the panel is empty

  Scenario: notifications require authentication
    When an unauthenticated client requests the notifications list
    Then the request is rejected as unauthorized
