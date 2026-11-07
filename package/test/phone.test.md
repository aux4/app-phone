# Phone

## app metadata

```execute
aux4 platform app phone meta
```

```expect:partial
"name": "Phone"
```

## anonymous action is denied

```execute
aux4 platform app phone calls --principal '{}'
```

```expect:partial
Sign in with your aux4 account
```
