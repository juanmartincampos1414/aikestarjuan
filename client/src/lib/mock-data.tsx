import React, { createContext, useContext, useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';

// Types matching the Prisma Schema provided
export type User = {
  id: string;
  email: string;
  name: string;
};

export type Organization = {
  id: string;
  name: string;
};

export type AccountType = 'cash' | 'bank' | 'wallet';

export type Account = {
  id: string;
  name: string;
  type: AccountType;
  balance: number;
  organizationId: string;
};

export type TransactionType = 'income' | 'expense' | 'payable' | 'receivable';

export type Transaction = {
  id: string;
  type: TransactionType;
  amount: number;
  description: string;
  category: string; // "Concepto"
  date: string; // ISO string - Real date
  imputationDate: string; // ISO string - Month imputation
  accountId?: string; // Optional for payable/receivable initially
  organizationId: string;
  hasInvoice: boolean;
  invoiceData?: {
    type: string;
    number: string;
    taxId: string; // CUIT
  };
  status: 'scheduled' | 'completed' | 'cancelled';
};

// Mock Data Context
interface DataContextType {
  user: User | null;
  organization: Organization | null;
  accounts: Account[];
  transactions: Transaction[];
  login: (email: string) => void;
  logout: () => void;
  addAccount: (account: Omit<Account, 'id' | 'organizationId'>) => void;
  addTransaction: (transaction: Omit<Transaction, 'id' | 'organizationId'>) => void;
  getAccountBalance: (accountId: string) => number;
  getTotalBalance: () => number;
  updateUser: (name: string, email: string) => void;
  updateOrganization: (name: string) => void;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

// Initial Seed Data
const INITIAL_USER = { id: 'u1', email: 'demo@aikestar.com', name: 'Demo User' };
const INITIAL_ORG = { id: 'o1', name: 'Mi Empresa S.A.' };
const INITIAL_ACCOUNTS: Account[] = [
  { id: 'a1', name: 'Banco Galicia', type: 'bank', balance: 150000, organizationId: 'o1' },
  { id: 'a2', name: 'Caja Chica', type: 'cash', balance: 25000, organizationId: 'o1' },
  { id: 'a3', name: 'Caja B', type: 'cash', balance: 50000, organizationId: 'o1' }, // "Black" box for demo
];
const INITIAL_TRANSACTIONS: Transaction[] = [
  { 
    id: 't1', 
    type: 'income', 
    amount: 500000, 
    description: 'Venta Servicios Enero', 
    category: 'Ventas', 
    date: new Date(Date.now() - 86400000 * 5).toISOString(), 
    imputationDate: new Date().toISOString(),
    accountId: 'a1', 
    organizationId: 'o1',
    hasInvoice: true,
    status: 'completed'
  },
  { 
    id: 't2', 
    type: 'expense', 
    amount: 12000, 
    description: 'Pago Internet', 
    category: 'Servicios', 
    date: new Date(Date.now() - 86400000 * 2).toISOString(), 
    imputationDate: new Date().toISOString(),
    accountId: 'a1', 
    organizationId: 'o1',
    hasInvoice: true,
    status: 'completed'
  },
];

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // Load initial data on mount (simulating DB fetch)
  useEffect(() => {
    // Check if we have a session (mock)
    const storedUser = localStorage.getItem('aikestar_user');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
      setOrganization(INITIAL_ORG);
      setAccounts(INITIAL_ACCOUNTS);
      setTransactions(INITIAL_TRANSACTIONS);
    }
  }, []);

  const login = (email: string) => {
    const newUser = { ...INITIAL_USER, email };
    setUser(newUser);
    setOrganization(INITIAL_ORG);
    setAccounts(INITIAL_ACCOUNTS);
    setTransactions(INITIAL_TRANSACTIONS);
    localStorage.setItem('aikestar_user', JSON.stringify(newUser));
  };

  const logout = () => {
    setUser(null);
    setOrganization(null);
    setAccounts([]);
    setTransactions([]);
    localStorage.removeItem('aikestar_user');
  };
  
  const updateUser = (name: string, email: string) => {
     if (user) {
        const updatedUser = { ...user, name, email };
        setUser(updatedUser);
        localStorage.setItem('aikestar_user', JSON.stringify(updatedUser));
     }
  };

  const updateOrganization = (name: string) => {
     if (organization) {
        setOrganization({ ...organization, name });
     }
  };

  const addAccount = (newAccount: Omit<Account, 'id' | 'organizationId'>) => {
    if (!organization) return;
    const account = { ...newAccount, id: uuidv4(), organizationId: organization.id };
    setAccounts([...accounts, account]);
  };

  const addTransaction = (newTransaction: Omit<Transaction, 'id' | 'organizationId'>) => {
    if (!organization) return;
    const transaction = { 
      ...newTransaction, 
      id: uuidv4(), 
      organizationId: organization.id 
    };
    
    setTransactions([transaction, ...transactions]);

    // Update account balance if it's a completed transaction with an account
    if (transaction.status === 'completed' && transaction.accountId) {
      setAccounts(prevAccounts => prevAccounts.map(acc => {
        if (acc.id === transaction.accountId) {
          const amount = transaction.type === 'income' ? transaction.amount : -transaction.amount;
          return { ...acc, balance: acc.balance + amount };
        }
        return acc;
      }));
    }
  };

  const getAccountBalance = (accountId: string) => {
    return accounts.find(a => a.id === accountId)?.balance || 0;
  };

  const getTotalBalance = () => {
    return accounts.reduce((sum, acc) => sum + acc.balance, 0);
  };

  return (
    <DataContext.Provider value={{ 
      user, 
      organization, 
      accounts, 
      transactions, 
      login, 
      logout,
      updateUser,
      updateOrganization,
      addAccount,
      addTransaction,
      getAccountBalance,
      getTotalBalance
    }}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const context = useContext(DataContext);
  if (context === undefined) {
    throw new Error('useData must be used within a DataProvider');
  }
  return context;
}
