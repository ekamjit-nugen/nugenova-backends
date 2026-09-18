Feature: Vendors — supplier companies and the people they supply
  An organization keeps a record of the vendors it buys from: staffing partners
  and subcontractors, the contacts it deals with there, and the contractors each
  vendor supplies, with the rate the vendor charges. Everything is org-scoped.
  Management needs the `vendors` permission; owners and admins always have it.

  Scenario: an admin adds a vendor
    Given an organization
    When the owner creates a vendor "Acme Contractors"
    Then the vendor is stored with status "active" and onboarding "invited"
    And the vendor appears in the org's vendor list

  Scenario: duplicate company names are rejected
    Given an organization with a vendor "Acme Contractors"
    When the owner creates a vendor "Acme Contractors" again
    Then the create is rejected as a conflict

  @security
  Scenario: an employee without the vendors permission cannot see vendors
    Given an organization with a vendor "Acme Contractors" and an employee member
    When the employee asks for the vendor list
    Then the request is rejected as forbidden

  Scenario: a role granted vendors:view can read but not change vendors
    Given an organization with a vendor "Acme Contractors" and a member whose role grants "vendors:view"
    When that member asks for the vendor list
    Then the list includes "Acme Contractors"
    But creating a vendor is rejected as forbidden

  Scenario: an admin adds a contractor supplied by a vendor
    Given an organization with a vendor "Acme Contractors"
    When the owner adds the contractor "Amit Sharma" at 8000 per "day"
    Then the vendor's people list includes "Amit Sharma" with rate 8000 per "day"
    And the contractor is not a member of the organization

  Scenario: a supplied contractor can be made a secondary member of the org
    Given an organization with a vendor "Acme Contractors"
    And the contractor "Amit Sharma" with an email, supplied by that vendor
    When the owner makes them a secondary member
    Then they appear in the directory badged as supplied by "Acme Contractors"
    But the staff directory does not include them
    When the owner takes them back out
    Then they are gone from the directory again
    And their record at the vendor is still there

  Scenario: someone with no email cannot be a secondary member
    Given an organization with a vendor "Acme Contractors"
    And the contractor "Amit Sharma" already supplied by that vendor
    When the owner makes them a secondary member
    Then the request is rejected, asking for an email

  Scenario: the same contractor cannot be added twice to one vendor
    Given an organization with a vendor "Acme Contractors"
    And the contractor "Amit Sharma" already supplied by that vendor
    When the owner adds a contractor with the same email
    Then the create is rejected as a conflict

  Scenario: one contact at a time is the primary
    Given an organization with a vendor "Acme Contractors"
    And a primary contact "Riya" at that vendor
    When the owner adds another primary contact "Neha"
    Then only "Neha" is primary

  Scenario: deleting a vendor takes its contacts and people with it
    Given an organization with a vendor "Acme Contractors"
    And the contractor "Amit Sharma" already supplied by that vendor
    When the owner deletes the vendor
    Then the vendor is gone from the list
    And the contractor no longer appears anywhere

  Scenario: vendors of another organization are never visible
    Given two organizations each with a vendor
    When the first owner asks for the vendor list
    Then only the first organization's vendor is listed

  Scenario: the stats header counts vendors and supplied people
    Given an organization with a vendor "Acme Contractors"
    And the contractor "Amit Sharma" already supplied by that vendor
    When the owner asks for vendor stats
    Then the stats report 1 vendor and 1 supplied person
