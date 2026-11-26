# Solus Cloud address

The Solus Cloud address is the control plane that a Solus app signs in to. The
default is `https://app.solus.sh`. Change it only when your organization hosts
its own Solus Cloud. Your administrator gives you the address, for example
`https://solus.example.com`.

## Change the address

Sign out first. The address can change only while you are signed out.

- **Desktop:** open **Settings → Account & sync**. In **Account**, enter the
  address in **Solus Cloud address** and select **Save**. Then select
  **Sign in**. To go back, select **Use app.solus.sh**.
- **Mobile:** open **Settings → Solus account & sync**. Select **Use a
  different Solus Cloud address**, enter the address, and select **Save**.
  Then select **Sign in to Solus Cloud**.
- **Web:** there is nothing to set. Open the web client at the address of your
  Solus Cloud.
- **Command line:** use `--cloud-url` or the `SOLUS_CLOUD_URL` environment
  variable.

While you are signed in, the same place shows the address and tells you to sign
out to change it.

## Rules for the address

- The address starts with `https://`. An address with no scheme is read as
  `https://`.
- `http://` is accepted only for this device: `localhost`, `127.0.0.1`, or
  `[::1]`.
- The address has no path, no query, and no user name or password.

When the app refuses an address, it says which rule the address broke.

## What the address applies to

- The address is a choice of one device. Solus keeps it on that device across
  restarts.
- It is not a host setting and it does not sync. Each desktop and each phone
  has its own.
- A sign-in belongs to the address that issued it. Solus never sends the
  sign-in of one address to another address.
- On desktop, the `SOLUS_CLOUD_URL` environment variable wins over the setting.
  Settings then shows the address and says that the variable sets it.
- A host that is registered to an account stays registered at the Solus Cloud
  that registered it. A sign-in at another address does not move it.

## If sign-in fails

If the app cannot read the sign-in information at the address, sign-in stops
and the app shows "Could not reach Solus Cloud at …". Check the address and
your connection, then try again.
