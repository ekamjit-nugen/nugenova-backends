Feature: Sales access follows the role matrix
  Sales & Leads is reachable by owners and admins, and by anyone whose custom
  role grants the `sales` resource — with each action (view, create, edit,
  delete, export) granted separately. It used to be open to every signed-in
  member through the API while the sidebar hid it from everyone but admins.

  @security
  Scenario: a member with no sales grant cannot reach leads
    Given an organization with a member who has no sales permission
    When that member lists the leads
    Then the request is forbidden
    And exporting the leads is forbidden too

  Scenario: a sales rep can work leads but only within their grant
    Given an organization with a sales rep who may view, create, edit and export leads
    When the rep creates a lead and lists the leads
    Then the lead is created and appears in the list
    And the rep can export the leads
    But the rep cannot delete the lead

  Scenario: the owner can do everything, including delete
    Given an organization with a sales rep who may view, create, edit and export leads
    When the rep creates a lead and lists the leads
    Then the owner can delete that lead

  @security
  Scenario: reshaping the pipeline stays with owners and admins
    Given an organization with a sales rep who may view, create, edit and export leads
    When the rep tries to add a pipeline stage
    Then the request is forbidden
    And the owner can add a pipeline stage
