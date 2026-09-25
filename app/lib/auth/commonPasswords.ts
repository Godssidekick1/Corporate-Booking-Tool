// The passwords people pick most often that are long enough to pass the length
// rule, compared case-insensitively. Short on purpose: a handful of
// well-known lists plus the obvious ones for this product and this company.
// Not a breach corpus. It stops the guesses an attacker tries first.
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password@123', 'password!',
  'passw0rd', 'p@ssw0rd', 'p@ssword', 'p@ssword1', 'p@ssw0rd1', 'pass@123', 'pass@1234', 'passpass',
  '12345678', '123456789', '1234567890', '0123456789', '87654321', '11111111', '00000000', '12341234',
  '11223344', '12344321', '123123123', '112233445566', '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'zaq12wsx',
  'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1',
  'abcd1234', 'abc12345', 'abcdefgh', 'aa123456', 'iloveyou', 'iloveyou1', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'batman123', 'starwars', 'trustno1', 'whatever', 'computer',
  'welcome1', 'welcome123', 'welcome@123', 'letmein1', 'letmein123', 'changeme', 'changeme1', 'default1',
  'admin123', 'admin1234', 'admin@123', 'administrator', 'test1234', 'testtest', 'secret123',
  'india123', 'india@123', 'mumbai123', 'delhi123', 'bangalore', 'cricket1', 'sachin10',
  'amadeus', 'amadeus1', 'amadeus123', 'amadeus@123', 'traveldesk', 'traveldesk1', 'traveldesk123',
  'travel123', 'travel@123', 'booking123', 'corporate', 'company123',
])
