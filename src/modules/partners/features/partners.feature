Feature: Partners — clients and vendors in one place
  An organization works with companies on both sides: clients it supplies people
  to, and vendors that supply people to it. They are the same record with a
  category, so one list shows both, and adding one asks which it is. What differs
  is the direction of people — and that is what the category decides.

  Scenario: adding a partner asks which side it is on
    Given an organization
    When the owner adds a client "Acme Retail" and a vendor "Nova Staffing"
    Then both appear in one partner list, each with its category
    And the client counts the people we assign to them, the vendor the people they supply

  Scenario: the list can be narrowed to one side
    Given an organization with a client and a vendor
    When the owner lists only vendors
    Then only the vendor is listed

  Scenario: a partner keeps its category for life
    Given an organization with a client "Acme Retail"
    When the owner renames it
    Then it is still a client

  Scenario: the same name can exist on both sides
    Given an organization with a client "Acme Retail"
    When the owner adds a vendor also called "Acme Retail"
    Then both exist
    But adding a second client called "Acme Retail" is rejected

  Scenario: one field covers a client's industry and a vendor's service
    Given an organization
    When the owner adds a client in "Retail" and a vendor in "Staffing"
    Then each reports its own sector

  Scenario: contacts come from one table, whichever side the partner is on
    Given an organization with a client and a vendor
    And each has a contact
    When the owner lists the partners
    Then each shows one contact
    And neither side can see the other's contact

  @security
  Scenario: a role granted only one side sees only that side
    Given an organization with a client and a vendor
    And a member whose role grants "clients:view" only
    When that member lists the partners
    Then only the client is listed
    And adding a vendor is rejected as forbidden

  @security
  Scenario: partners never cross organizations
    Given two organizations each with a partner
    When the first owner lists the partners
    Then only their own is listed
