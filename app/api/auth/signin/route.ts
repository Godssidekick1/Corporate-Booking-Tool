import { createClient } from '@/utils/supabase/server'
import { NextRequest } from 'next/server'

export async function POST(req: NextRequest) {
  const { email, password } = await req.json()

  if (!email || !password) {
    return Response.json(
      { error: 'email and password are required' },
      { status: 400 }
    )
  }

  const supabase = await createClient()

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  })

  if (error) {
    return Response.json({ error: error.message }, { status: 401 })
  }

  return Response.json({
    ok: true,
    user: {
      id: data.user.id,
      email: data.user.email,
    },
  })
}