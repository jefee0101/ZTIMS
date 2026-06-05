import { supabase } from './supabase.js'

const msg = document.getElementById('message')

window.login = async () => {
  const email = document.getElementById('email').value
  const password = document.getElementById('password').value

  // 1. LOGIN
  const { data: loginData, error: loginError } =
    await supabase.auth.signInWithPassword({
      email,
      password
    })

  if (loginError) {
    msg.innerText = loginError.message
    return
  }

  const user = loginData.user

  // 2. FETCH ROLE FROM SUPABASE
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profileError) {
    msg.innerText = 'Failed to fetch role'
    return
  }

  // 3. APPLY ROLE UI
  if (profile.role === 'admin') {
    updateRole('admin')
    msg.innerText = 'Welcome Admin'
  } else {
    updateRole('traveler')
    msg.innerText = 'Welcome Traveler'
  }
}