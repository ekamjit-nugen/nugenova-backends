Feature: LMS — courses, classes/sections and enrolment
  The LMS structure + enrolment layer sits on the academic calendar. Courses and
  their taught class/sections are authored only by an org's owner/admin, strictly
  within their own org. A class teacher must be a STAFF member; only STUDENT
  memberships can be enrolled; a student can't be enrolled twice; capacity is
  enforced; withdrawal is a soft status transition; and a class roster lists only
  the enrolled students (never the staff directory).

  Scenario: an owner creates a course and a class/section
    Given an organization with an academic year and term
    When the owner creates a course and a class in that term
    Then the course and class are created

  Scenario: an employee cannot author courses
    Given an organization with an employee
    When the employee tries to create a course
    Then the request is rejected as forbidden

  Scenario: one org cannot see another org's courses
    Given two organizations that each have a course
    When the first organization's owner lists courses
    Then only the first organization's courses are returned

  Scenario: a class teacher must be a staff member
    Given an organization with a course, a term and a student membership
    When the owner tries to assign the student as the class teacher
    Then the request is rejected as a bad request

  Scenario: only a student membership can be enrolled
    Given an organization with a class and a staff member
    When the owner tries to enrol the staff member
    Then the request is rejected as a bad request

  Scenario: a student is enrolled and cannot be enrolled twice
    Given an organization with a class and a student membership
    When the owner enrols the student
    Then the student is enrolled
    And enrolling the same student again is rejected

  Scenario: capacity is enforced
    Given an organization with a class of capacity one and two students
    When the owner enrols the first student
    Then enrolling the second student is rejected as full

  Scenario: withdrawing is a soft status transition
    Given an organization with a class and an enrolled student
    When the owner withdraws the student
    Then the enrolment status becomes withdrawn and the row still exists

  Scenario: the class roster lists only enrolled students
    Given an organization with a class, an enrolled student and a withdrawn student
    When the owner reads the class roster
    Then only the enrolled student appears on the roster
