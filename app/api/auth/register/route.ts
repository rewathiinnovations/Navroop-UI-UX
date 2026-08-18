import { NextRequest, NextResponse } from "next/server";
import { registerAccount } from "@/lib/legal/register";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await registerAccount({
      name: body.name,
      email: body.email,
      password: body.password,
      acceptTerms: Boolean(body.acceptTerms),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: result.status },
      );
    }

    return NextResponse.json({ user: result.user }, { status: 201 });
  } catch (error) {
    console.error("[register]", error);
    return NextResponse.json({ error: "Could not create account" }, { status: 500 });
  }
}
