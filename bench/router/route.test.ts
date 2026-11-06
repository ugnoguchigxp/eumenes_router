import { expect, test } from "bun:test";
import { main } from "./main.ts";
test("run --algo best-v2 is the route command and needs an artifact", async () => {
	await expect(
		main(
			["run", "--algo", "best-v2", "--db", "x.db", "--text", "hi"],
			() => {},
		),
	).rejects.toThrow(/artifact/);
	await expect(
		main(["route", "--db", "x.db", "--artifact", "a"], () => {}),
	).rejects.toThrow(/text/);
});
