Feature: Assessment — gradebook, marks and student reports
  The gradebook sits on the lms roster and the academic calendar. Assessments and
  marks are authored only by an org's owner/admin, strictly within their own org.
  An assessment inherits its class's term; only an actively-enrolled STUDENT can be
  graded; a mark must be within [0, maxMarks]; re-grading updates the same mark row
  (never a duplicate); the class gradebook rolls each student up to a weighted
  total; and a student report shows one student's marks across the class.

  Scenario: an owner creates an assessment on a class
    Given an organization with a class in a term
    When the owner creates an assessment for that class
    Then the assessment is created with the class's term

  Scenario: an employee cannot author assessments
    Given an organization with a class and an employee
    When the employee tries to create an assessment
    Then the request is rejected as forbidden

  Scenario: one org cannot grade into another org's class
    Given two organizations that each have a class
    When the first organization's owner reads the second organization's gradebook
    Then the request is rejected as not found

  Scenario: only an enrolled student can be graded
    Given an organization with an assessment and a withdrawn student
    When the owner tries to record a mark for the withdrawn student
    Then the request is rejected as a bad request

  Scenario: a mark must be within range
    Given an organization with an assessment out of twenty and an enrolled student
    When the owner records a mark above the maximum
    Then the request is rejected as a bad request

  Scenario: recording and re-grading updates the same mark row
    Given an organization with an assessment and an enrolled student
    When the owner records a mark and then re-grades it
    Then the latest mark is stored on a single row

  Scenario: the class gradebook rolls up a weighted total
    Given an organization with two weighted assessments and an enrolled student
    When the owner records marks and reads the gradebook
    Then the student's weighted percentage is computed

  Scenario: a student report shows the student's marks and overall
    Given an organization with an assessment and a graded student
    When the owner reads the student's report
    Then the report lists the marks and the overall weighted percentage
